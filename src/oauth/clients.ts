import { isIP } from "node:net";
import { log } from "../log.js";
import { type Signer, safeEqual } from "./signer.js";

export type ClientAuthMethod = "none" | "client_secret_post" | "client_secret_basic";
export const CLIENT_AUTH_METHODS: ClientAuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];

export interface OAuthClient {
  clientId: string;
  name?: string;
  redirectUris: string[];
  authMethod: ClientAuthMethod;
  kind: "dcr" | "cimd";
}

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

const DCR_PREFIX = "mcp_";
const CIMD_CACHE_MS = 10 * 60 * 1000;
const CIMD_MAX_BYTES = 64 * 1024;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https, http on loopback, or a native-app custom scheme (cursor://, vscode://). */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return !["javascript:", "data:", "file:", "blob:", "about:", "vbscript:", "ftp:", "ws:", "wss:"].includes(url.protocol);
}

/** Exact match, except that loopback redirect URIs may use any port (RFC 8252 §7.3). */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    return (
      a.protocol === "http:" &&
      b.protocol === "http:" &&
      LOOPBACK.has(a.hostname) &&
      a.hostname === b.hostname &&
      a.pathname === b.pathname &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(host) === 6) return true; // no IPv6 literals for client metadata
  return false;
}

/**
 * Stateless client registry:
 *  - Dynamic Client Registration: the client_id is a signed blob holding the client's metadata,
 *    the client_secret (for confidential clients) is an HMAC of the client_id. Nothing is stored.
 *  - Client ID Metadata Documents (CIMD): the client_id is an https URL that we fetch and validate.
 */
export class ClientRegistry {
  private readonly cimdCache = new Map<string, { client: OAuthClient; expires: number }>();

  constructor(private readonly signer: Signer) {}

  register(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== "object") throw new OAuthError("invalid_client_metadata", "Body must be a JSON object.");
    const meta = body as Record<string, unknown>;
    const redirectUris = meta.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
      throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a non-empty array (max 10).");
    }
    for (const uri of redirectUris) {
      if (typeof uri !== "string" || uri.length > 2000 || !isAllowedRedirectUri(uri)) {
        throw new OAuthError("invalid_redirect_uri", `Redirect URI not allowed: ${String(uri)}`);
      }
    }
    const requested = (meta.token_endpoint_auth_method as string | undefined) ?? "client_secret_basic";
    if (!CLIENT_AUTH_METHODS.includes(requested as ClientAuthMethod)) {
      throw new OAuthError("invalid_client_metadata", `Unsupported token_endpoint_auth_method: ${requested}`);
    }
    const authMethod = requested as ClientAuthMethod;
    const name = typeof meta.client_name === "string" ? meta.client_name.slice(0, 100) : undefined;

    const clientId = DCR_PREFIX + this.signer.sign("client", { r: redirectUris, n: name, a: authMethod });
    const response: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: authMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    if (authMethod !== "none") {
      response.client_secret = this.secretFor(clientId);
      response.client_secret_expires_at = 0;
    }
    log.info(`OAuth client registered: ${name ?? "(unnamed)"} -> ${redirectUris.join(", ")}`);
    return response;
  }

  private secretFor(clientId: string): string {
    return this.signer.mac("client-secret", clientId);
  }

  checkSecret(client: OAuthClient, secret: string | undefined): boolean {
    if (client.authMethod === "none") return true;
    return typeof secret === "string" && safeEqual(secret, this.secretFor(client.clientId));
  }

  async resolve(clientId: string | undefined | null): Promise<OAuthClient | undefined> {
    if (!clientId) return undefined;
    if (clientId.startsWith(DCR_PREFIX)) {
      const claims = this.signer.verify<{ r: string[]; n?: string; a: ClientAuthMethod }>("client", clientId.slice(DCR_PREFIX.length));
      if (!claims || !Array.isArray(claims.r)) return undefined;
      return { clientId, name: claims.n, redirectUris: claims.r, authMethod: claims.a ?? "none", kind: "dcr" };
    }
    if (clientId.startsWith("https://")) return this.resolveCimd(clientId);
    return undefined;
  }

  private async resolveCimd(clientId: string): Promise<OAuthClient | undefined> {
    const cached = this.cimdCache.get(clientId);
    if (cached && cached.expires > Date.now()) return cached.client;

    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      return undefined;
    }
    if (url.protocol !== "https:" || url.pathname === "/" || url.hash || url.username || url.password) return undefined;
    if (isPrivateHost(url.hostname)) return undefined;

    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > CIMD_MAX_BYTES) throw new Error("metadata document too large");
      const doc = JSON.parse(text);
      if (doc?.client_id !== clientId) throw new Error("client_id in document does not match its URL");
      const redirectUris = Array.isArray(doc.redirect_uris)
        ? doc.redirect_uris.filter((u: unknown): u is string => typeof u === "string" && isAllowedRedirectUri(u))
        : [];
      if (!redirectUris.length) throw new Error("no valid redirect_uris");
      const client: OAuthClient = {
        clientId,
        name: typeof doc.client_name === "string" ? doc.client_name.slice(0, 100) : url.hostname,
        redirectUris,
        authMethod: "none", // public client + PKCE
        kind: "cimd",
      };
      this.cimdCache.set(clientId, { client, expires: Date.now() + CIMD_CACHE_MS });
      return client;
    } catch (err) {
      log.warn(`Could not load client metadata document ${clientId}: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }
}
