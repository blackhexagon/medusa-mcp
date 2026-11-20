import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config, OAuthConfig } from "../config.js";
import { log } from "../log.js";
import type { MedusaClient } from "../medusa/client.js";
import { CLIENT_AUTH_METHODS, ClientRegistry, OAuthError, type OAuthClient, redirectUriMatches } from "./clients.js";
import { type AdminIdentity, type LoginResult, MedusaAuth } from "./medusa-auth.js";
import { type ConsentInfo, PAGE_HEADERS, errorPage, loginPage, mfaPage } from "./pages.js";
import { Signer, pkceChallenge } from "./signer.js";

export const SCOPE = "mcp";
const CODE_TTL = 120;
const AUTH_REQUEST_TTL = 15 * 60;
const MFA_TTL = 5 * 60;

export interface TokenIdentity {
  sub: string;
  email: string;
  clientId: string;
}

interface AuthRequest {
  c: string; // client_id
  r: string; // redirect_uri
  s?: string; // state
  cc: string; // code_challenge
  res: string; // resource
  n: string; // client name (for display)
}

const CORS_PUBLIC = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
};

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...CORS_PUBLIC, ...headers });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, PAGE_HEADERS);
  res.end(html);
}

async function readForm(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new OAuthError("invalid_request", "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      const parsed = JSON.parse(raw || "{}");
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
    } catch {
      throw new OAuthError("invalid_request", "Invalid JSON body.");
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new OAuthError("invalid_client_metadata", "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new OAuthError("invalid_client_metadata", "Invalid JSON body.");
  }
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

/** Fixed-window limiter for failed logins (per IP). */
class LoginLimiter {
  private readonly hits = new Map<string, { count: number; reset: number }>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}
  blocked(key: string): boolean {
    const hit = this.hits.get(key);
    return !!hit && hit.reset > Date.now() && hit.count >= this.max;
  }
  fail(key: string) {
    const now = Date.now();
    const hit = this.hits.get(key);
    if (!hit || hit.reset < now) this.hits.set(key, { count: 1, reset: now + this.windowMs });
    else hit.count++;
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
  }
}

/**
 * Minimal OAuth 2.1 authorization server + resource server metadata following the MCP
 * authorization spec. Users sign in with their Medusa admin account; tokens are stateless
 * HMAC-signed JWTs (rotate MCP_OAUTH_SECRET to revoke everything).
 */
export class OAuthProvider {
  readonly issuer: string;
  readonly resource: string;
  readonly resourceMetadataUrl: string;
  private readonly signer: Signer;
  private readonly clients: ClientRegistry;
  private readonly auth: MedusaAuth;
  private readonly limiter = new LoginLimiter();
  private readonly usedCodes = new Map<string, number>();
  private readonly oauth: OAuthConfig;

  constructor(
    private readonly config: Config,
    medusa: MedusaClient,
  ) {
    if (!config.oauth) throw new Error("OAuth is not configured");
    this.oauth = config.oauth;
    this.issuer = this.oauth.publicUrl;
    this.resource = `${this.oauth.publicUrl}${config.mcpPath}`;
    this.resourceMetadataUrl = `${this.oauth.publicUrl}/.well-known/oauth-protected-resource${config.mcpPath}`;
    this.signer = new Signer(this.oauth.secret);
    this.clients = new ClientRegistry(this.signer);
    this.auth = new MedusaAuth(config, medusa);
  }

  /** Value for the WWW-Authenticate header on 401 responses. */
  challenge(error?: "invalid_token"): string {
    return `Bearer resource_metadata="${this.resourceMetadataUrl}", scope="${SCOPE}"${error ? `, error="${error}"` : ""}`;
  }

  verifyAccessToken(token: string): TokenIdentity | null {
    const claims = this.signer.verify<{ sub: string; email: string; cid: string; aud: string }>("access", token);
    if (!claims || claims.aud !== this.resource) return null;
    return { sub: claims.sub, email: claims.email, clientId: claims.cid };
  }

  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
      scopes_supported: [SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: "https://github.com/blackhexagon/medusa-mcp",
    };
  }

  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: `Medusa Admin (${new URL(this.config.medusaBaseUrl).host})`,
    };
  }

  /** Handles OAuth-related routes. Returns false if the request is not an OAuth route. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname.replace(/\/+$/, "");
    const method = req.method ?? "GET";
    const isWellKnown = path.startsWith("/.well-known/oauth-");
    const isOAuth = path === "/oauth/authorize" || path === "/oauth/token" || path === "/oauth/register";
    if (!isWellKnown && !isOAuth) return false;

    if (method === "OPTIONS") {
      res.writeHead(204, CORS_PUBLIC).end();
      return true;
    }

    try {
      if (path === "/.well-known/oauth-protected-resource" || path === `/.well-known/oauth-protected-resource${this.config.mcpPath}`) {
        sendJson(res, 200, this.protectedResourceMetadata(), { "cache-control": "public, max-age=3600" });
      } else if (path === "/.well-known/oauth-authorization-server") {
        sendJson(res, 200, this.authorizationServerMetadata(), { "cache-control": "public, max-age=3600" });
      } else if (path === "/oauth/register" && method === "POST") {
        sendJson(res, 201, this.clients.register(await readJson(req)));
      } else if (path === "/oauth/authorize" && method === "GET") {
        await this.authorizeGet(res, url);
      } else if (path === "/oauth/authorize" && method === "POST") {
        await this.authorizePost(req, res);
      } else if (path === "/oauth/token" && method === "POST") {
        await this.token(req, res);
      } else if (isWellKnown) {
        sendJson(res, 404, { error: "not_found" });
      } else {
        sendJson(res, 405, { error: "invalid_request", error_description: "Method not allowed" });
      }
    } catch (err) {
      if (err instanceof OAuthError) {
        sendJson(res, err.status, { error: err.error, error_description: err.description });
      } else {
        log.error("OAuth endpoint failed", err);
        if (!res.headersSent) sendJson(res, 500, { error: "server_error", error_description: "Internal error" });
      }
    }
    return true;
  }

  // --- /oauth/authorize --------------------------------------------------------------------------

  private redirectWith(res: ServerResponse, redirectUri: string, params: Record<string, string | undefined>) {
    const target = new URL(redirectUri);
    for (const [k, v] of Object.entries({ ...params, iss: this.issuer })) if (v !== undefined) target.searchParams.set(k, v);
    res.writeHead(302, { location: target.toString(), "cache-control": "no-store" });
    res.end();
  }

  private normalizeResource(value: string | null | undefined): string | null {
    if (!value) return this.resource;
    const v = value.replace(/\/+$/, "");
    return v === this.resource || v === this.issuer ? this.resource : null;
  }

  private consentInfo(req: AuthRequest, requestToken: string, extra: Partial<ConsentInfo> = {}): ConsentInfo {
    let redirectHost: string;
    try {
      const u = new URL(req.r);
      redirectHost = u.host || `${u.protocol}//`;
    } catch {
      redirectHost = req.r;
    }
    return { requestToken, clientName: req.n, redirectHost, storeHost: new URL(this.config.medusaBaseUrl).host, ...extra };
  }

  private async authorizeGet(res: ServerResponse, url: URL) {
    const q = url.searchParams;
    const client = await this.clients.resolve(q.get("client_id"));
    if (!client) {
      sendHtml(res, 400, errorPage("Unknown client_id. Remove the connector in your MCP client and add it again."));
      return;
    }
    let redirectUri = q.get("redirect_uri");
    if (!redirectUri && client.redirectUris.length === 1) redirectUri = client.redirectUris[0];
    if (!redirectUri || !client.redirectUris.some((r) => redirectUriMatches(r, redirectUri!))) {
      sendHtml(res, 400, errorPage("The redirect_uri is not registered for this client."));
      return;
    }
    const state = q.get("state") ?? undefined;
    const fail = (error: string, description: string) =>
      this.redirectWith(res, redirectUri!, { error, error_description: description, state });

    if (q.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    const challenge = q.get("code_challenge");
    if (!challenge || q.get("code_challenge_method") !== "S256") {
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return fail("invalid_request", "Invalid code_challenge.");
    const resource = this.normalizeResource(q.get("resource"));
    if (!resource) return fail("invalid_target", `Unknown resource. Use ${this.resource}.`);

    const authReq: AuthRequest = {
      c: client.clientId,
      r: redirectUri,
      s: state,
      cc: challenge,
      res: resource,
      n: client.name ?? "An MCP client",
    };
    const token = this.signer.sign("authreq", authReq as unknown as Record<string, unknown>, AUTH_REQUEST_TTL);
    sendHtml(res, 200, loginPage(this.consentInfo(authReq, token)));
  }

  private async authorizePost(req: IncomingMessage, res: ServerResponse) {
    const form = await readForm(req);
    const requestToken = form.request;
    const authReq = this.signer.verify<AuthRequest & Record<string, unknown>>("authreq", requestToken);
    if (!authReq) {
      sendHtml(res, 400, errorPage("This sign-in request has expired. Start the connection again from your MCP client."));
      return;
    }

    if (form.action === "deny") {
      this.redirectWith(res, authReq.r, { error: "access_denied", error_description: "The user denied access.", state: authReq.s });
      return;
    }

    const ip = clientIp(req);
    if (this.limiter.blocked(ip)) {
      sendHtml(res, 429, loginPage(this.consentInfo(authReq, requestToken, { error: "Too many failed attempts. Try again in 15 minutes." })));
      return;
    }

    let result: LoginResult;
    let email: string;
    if (form.mfa) {
      const mfa = this.signer.verify<{ ch: string; email: string; rq: string }>("mfa", form.mfa);
      if (!mfa || mfa.rq !== authReq.jti) {
        sendHtml(res, 400, loginPage(this.consentInfo(authReq, requestToken, { error: "Verification expired, sign in again." })));
        return;
      }
      email = mfa.email;
      result = await this.auth.verifyMfa(mfa.ch, form.method === "recovery-code" ? "recovery-code" : "totp", (form.code ?? "").trim(), email);
      if (result.kind === "invalid") {
        this.limiter.fail(ip);
        sendHtml(res, 401, mfaPage({ ...this.consentInfo(authReq, requestToken, { error: result.message, email }), mfaToken: form.mfa }));
        return;
      }
    } else {
      email = (form.email ?? "").trim().toLowerCase();
      const password = form.password ?? "";
      if (!email || !password) {
        sendHtml(res, 400, loginPage(this.consentInfo(authReq, requestToken, { error: "Enter your email and password.", email })));
        return;
      }
      result = await this.auth.login(email, password);
      if (result.kind === "invalid") {
        this.limiter.fail(ip);
        log.warn(`OAuth login failed for ${email} from ${ip}`);
        sendHtml(res, 401, loginPage(this.consentInfo(authReq, requestToken, { error: result.message, email })));
        return;
      }
      if (result.kind === "mfa") {
        const mfaToken = this.signer.sign("mfa", { ch: result.challengeId, email, rq: authReq.jti }, MFA_TTL);
        sendHtml(res, 200, mfaPage({ ...this.consentInfo(authReq, requestToken, { email }), mfaToken }));
        return;
      }
    }

    if (result.kind !== "ok") throw new Error("unexpected login state");
    if (!this.emailAllowed(result.user.email)) {
      log.warn(`OAuth login rejected for ${result.user.email}: not in MCP_OAUTH_ALLOWED_EMAILS`);
      sendHtml(res, 403, loginPage(this.consentInfo(authReq, requestToken, { error: "This account is not allowed to use this MCP server.", email })));
      return;
    }

    const code = this.signer.sign(
      "code",
      { c: authReq.c, r: authReq.r, cc: authReq.cc, res: authReq.res, sub: result.user.id, email: result.user.email },
      CODE_TTL,
    );
    log.info(`OAuth: ${result.user.email} authorized client "${authReq.n}"`);
    this.redirectWith(res, authReq.r, { code, state: authReq.s });
  }

  private emailAllowed(email: string): boolean {
    const allowed = this.oauth.allowedEmails;
    if (!allowed.length) return true;
    const e = email.toLowerCase();
    return allowed.some((a) => (a.startsWith("@") ? e.endsWith(a) : e === a));
  }

  // --- /oauth/token ------------------------------------------------------------------------------

  private async authenticateClient(req: IncomingMessage, form: Record<string, string>): Promise<OAuthClient> {
    let clientId = form.client_id;
    let secret = form.client_secret;
    const header = req.headers.authorization;
    if (header?.toLowerCase().startsWith("basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx >= 0) {
        clientId = decodeURIComponent(decoded.slice(0, idx));
        secret = decodeURIComponent(decoded.slice(idx + 1));
      }
    }
    const client = await this.clients.resolve(clientId);
    if (!client || !this.clients.checkSecret(client, secret)) {
      throw new OAuthError("invalid_client", "Client authentication failed.", 401);
    }
    return client;
  }

  private issueTokens(client: OAuthClient, user: AdminIdentity, resource: string) {
    const claims = { sub: user.id, email: user.email, cid: client.clientId, aud: resource, scope: SCOPE };
    return {
      access_token: this.signer.sign("access", claims, this.oauth.accessTokenTtl),
      token_type: "Bearer",
      expires_in: this.oauth.accessTokenTtl,
      refresh_token: this.signer.sign("refresh", claims, this.oauth.refreshTokenTtl),
      scope: SCOPE,
    };
  }

  private async token(req: IncomingMessage, res: ServerResponse) {
    const form = await readForm(req);
    const client = await this.authenticateClient(req, form);

    if (form.grant_type === "authorization_code") {
      const code = this.signer.verify<{ c: string; r: string; cc: string; res: string; sub: string; email: string }>("code", form.code);
      if (!code || code.c !== client.clientId) throw new OAuthError("invalid_grant", "Invalid or expired authorization code.");
      if (form.redirect_uri && form.redirect_uri !== code.r) throw new OAuthError("invalid_grant", "redirect_uri mismatch.");
      if (!form.code_verifier || pkceChallenge(form.code_verifier) !== code.cc) {
        throw new OAuthError("invalid_grant", "PKCE verification failed.");
      }
      if (form.resource && this.normalizeResource(form.resource) !== code.res) throw new OAuthError("invalid_target", "Resource mismatch.");
      this.consumeCode(code.jti, code.exp ?? 0);
      sendJson(res, 200, this.issueTokens(client, { id: code.sub, email: code.email }, code.res));
      return;
    }

    if (form.grant_type === "refresh_token") {
      const rt = this.signer.verify<{ sub: string; email: string; cid: string; aud: string }>("refresh", form.refresh_token);
      if (!rt || rt.cid !== client.clientId) throw new OAuthError("invalid_grant", "Invalid or expired refresh token.");
      if (form.resource && this.normalizeResource(form.resource) !== rt.aud) throw new OAuthError("invalid_target", "Resource mismatch.");
      if (!this.emailAllowed(rt.email) || !(await this.auth.userExists(rt.sub))) {
        throw new OAuthError("invalid_grant", "The Medusa user no longer has access.");
      }
      sendJson(res, 200, this.issueTokens(client, { id: rt.sub, email: rt.email }, rt.aud));
      return;
    }

    throw new OAuthError("unsupported_grant_type", "Supported grant types: authorization_code, refresh_token.");
  }

  /** Authorization codes are single-use (tracked in memory until they expire). */
  private consumeCode(jti: string, exp: number) {
    const now = Math.floor(Date.now() / 1000);
    for (const [k, v] of this.usedCodes) if (v < now) this.usedCodes.delete(k);
    if (this.usedCodes.has(jti)) throw new OAuthError("invalid_grant", "Authorization code was already used.");
    this.usedCodes.set(jti, exp);
  }
}
