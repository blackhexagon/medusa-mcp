import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http.js";
import { MedusaClient } from "../src/medusa/client.js";
import { OAuthProvider } from "../src/oauth/provider.js";
import { createMcpServer } from "../src/server.js";
import { Catalog, loadSpec } from "../src/spec/catalog.js";
import { buildTools } from "../src/tools/index.js";

const STATIC_TOKEN = "static-token-0123456789abcdef";
const REDIRECT = "https://client.example/callback";
const CIMD_URL = "https://cimd.example/oauth/client.json";

let medusa: Server;
let mcpHttp: Server;
let base: string;
const medusaAuthHeaders: string[] = [];
let goneUsers = new Set<string>();

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(body: Record<string, unknown>) {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const u = new URL(`${base}/oauth/authorize`);
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
    scope: "mcp",
    resource: `${base}/mcp`,
    ...extra,
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
}

async function getRequestToken(url: URL): Promise<string> {
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 200, await res.clone().text());
  const html = await res.text();
  const m = html.match(/name="request" value="([^"]+)"/);
  assert.ok(m, "login form should contain the request token");
  return m[1];
}

async function postForm(path: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

/** Runs the full browser part of the flow and returns the authorization code. */
async function authorize(clientId: string, challenge: string, email = "admin@shop.com", password = "secret") {
  const request = await getRequestToken(authorizeUrl(clientId, challenge));
  const res = await postForm("/oauth/authorize", { request, email, password, action: "login" });
  assert.equal(res.status, 302, await res.text());
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get("state"), "st4te");
  assert.equal(location.searchParams.get("iss"), base);
  return location.searchParams.get("code")!;
}

async function exchange(form: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await postForm("/oauth/token", form, headers);
  return { status: res.status, data: (await res.json()) as any };
}

before(async () => {
  medusa = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || "{}") : {};
    const url = new URL(req.url!, "http://x");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/auth/user/emailpass") {
      if (body.password !== "secret") return res.writeHead(401).end(JSON.stringify({ message: "Invalid email or password" }));
      if (body.email === "admin@shop.com") return res.end(JSON.stringify({ token: "jwt-admin" }));
      if (body.email === "mfa@shop.com") return res.end(JSON.stringify({ mfa_challenge: { id: "ch_1" } }));
      if (body.email === "other@elsewhere.com") return res.end(JSON.stringify({ token: "jwt-other" }));
      return res.writeHead(401).end("{}");
    }
    if (url.pathname === "/auth/mfa/challenges/ch_1/verify") {
      if (body.code === "123456" && body.method === "totp") return res.end(JSON.stringify({ token: "jwt-mfa" }));
      return res.writeHead(401).end("{}");
    }
    if (url.pathname === "/admin/users/me") {
      const users: Record<string, unknown> = {
        "Bearer jwt-admin": { id: "user_1", email: "admin@shop.com" },
        "Bearer jwt-mfa": { id: "user_2", email: "mfa@shop.com" },
        "Bearer jwt-other": { id: "user_3", email: "other@elsewhere.com" },
      };
      const user = users[req.headers.authorization ?? ""];
      return user ? res.end(JSON.stringify({ user })) : res.writeHead(401).end("{}");
    }
    const userMatch = url.pathname.match(/^\/admin\/users\/([^/]+)$/);
    if (userMatch) {
      if (goneUsers.has(userMatch[1])) return res.writeHead(404).end("{}");
      return res.end(JSON.stringify({ user: { id: userMatch[1] } }));
    }
    medusaAuthHeaders.push(req.headers.authorization ?? "");
    res.end(JSON.stringify({ ok: true, path: url.pathname }));
  });
  await new Promise<void>((r) => medusa.listen(0, "127.0.0.1", r));
  const medusaUrl = `http://127.0.0.1:${(medusa.address() as AddressInfo).port}`;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    MEDUSA_BASE_URL: medusaUrl,
    MEDUSA_API_KEY: "sk_service",
    MCP_AUTH_TOKENS: STATIC_TOKEN,
    MCP_OAUTH_SECRET: "x".repeat(40),
    MCP_PUBLIC_URL: base,
    MCP_OAUTH_ALLOWED_EMAILS: "@shop.com",
    PORT: String(port),
    HOST: "127.0.0.1",
  });
  const catalog = new Catalog(loadSpec(config), config);
  const client = new MedusaClient(config);
  const tools = buildTools({ config, catalog, client });
  mcpHttp = startHttpServer(
    config,
    (caller) => createMcpServer(config, tools, catalog.operations.length, caller),
    new OAuthProvider(config, client),
  );
  await new Promise<void>((resolve) => (mcpHttp.listening ? resolve() : mcpHttp.once("listening", resolve)));

  // Serve a Client ID Metadata Document for the CIMD test without real network access.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === CIMD_URL) {
      return new Response(JSON.stringify({ client_id: CIMD_URL, client_name: "CIMD Client", redirect_uris: [REDIRECT] }), {
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

after(() => {
  mcpHttp?.close();
  medusa?.close();
});

describe("discovery", () => {
  it("returns a 401 challenge pointing to the protected resource metadata", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  it("serves protected resource + authorization server metadata", async () => {
    const prm: any = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.resource, `${base}/mcp`);
    assert.deepEqual(prm.authorization_servers, [base]);

    const as: any = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.issuer, base);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    assert.equal(as.client_id_metadata_document_supported, true);
    assert.equal(as.authorization_response_iss_parameter_supported, true);
    assert.ok(as.registration_endpoint);
  });
});

describe("authorization code flow", () => {
  it("public client: register -> login -> token -> MCP call -> refresh", async () => {
    const reg = await register({ client_name: "Test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    assert.equal(reg.status, 201);
    assert.equal(reg.data.client_secret, undefined);
    const clientId = reg.data.client_id;

    const { verifier, challenge } = pkce();
    const code = await authorize(clientId, challenge);

    const bad = await exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: "wrong".repeat(10) });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, "invalid_grant");

    const tok = await exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${base}/mcp` });
    assert.equal(tok.status, 200, JSON.stringify(tok.data));
    assert.equal(tok.data.token_type, "Bearer");
    assert.ok(tok.data.access_token && tok.data.refresh_token);

    const reuse = await exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    assert.equal(reuse.data.error, "invalid_grant");

    // The access token works on the MCP endpoint; Medusa is still called with the service API key.
    const mcp = new Client({ name: "t", version: "1" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tok.data.access_token}` } },
      }),
    );
    const result: any = await mcp.callTool({ name: "medusa_call_operation", arguments: { operation_id: "GetProducts" } });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(medusaAuthHeaders.at(-1), `Basic ${Buffer.from("sk_service:").toString("base64")}`);
    await mcp.close();

    const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: tok.data.refresh_token, client_id: clientId });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
    assert.notEqual(refreshed.data.access_token, tok.data.access_token);

    // Refresh is rejected once the Medusa admin user is deleted.
    goneUsers = new Set(["user_1"]);
    const denied = await exchange({ grant_type: "refresh_token", refresh_token: tok.data.refresh_token, client_id: clientId });
    assert.equal(denied.data.error, "invalid_grant");
    goneUsers = new Set();
  });

  it("confidential client must authenticate with its secret", async () => {
    const reg = await register({ redirect_uris: [REDIRECT] }); // default: client_secret_basic
    assert.ok(reg.data.client_secret);
    const { verifier, challenge } = pkce();
    const code = await authorize(reg.data.client_id, challenge);

    const noSecret = await exchange({ grant_type: "authorization_code", code, client_id: reg.data.client_id, code_verifier: verifier });
    assert.equal(noSecret.status, 401);
    assert.equal(noSecret.data.error, "invalid_client");

    const basic = Buffer.from(`${encodeURIComponent(reg.data.client_id)}:${encodeURIComponent(reg.data.client_secret)}`).toString("base64");
    const ok = await exchange({ grant_type: "authorization_code", code, code_verifier: verifier }, { authorization: `Basic ${basic}` });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
  });

  it("supports Client ID Metadata Documents", async () => {
    const { verifier, challenge } = pkce();
    const page = await (await fetch(authorizeUrl(CIMD_URL, challenge))).text();
    assert.match(page, /CIMD Client/);
    const code = await authorize(CIMD_URL, challenge);
    const tok = await exchange({ grant_type: "authorization_code", code, client_id: CIMD_URL, code_verifier: verifier });
    assert.equal(tok.status, 200, JSON.stringify(tok.data));
  });

  it("handles MFA", async () => {
    const reg = await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const { challenge } = pkce();
    const request = await getRequestToken(authorizeUrl(reg.data.client_id, challenge));
    const step1 = await postForm("/oauth/authorize", { request, email: "mfa@shop.com", password: "secret", action: "login" });
    assert.equal(step1.status, 200);
    const mfa = (await step1.text()).match(/name="mfa" value="([^"]+)"/)![1];

    const wrong = await postForm("/oauth/authorize", { request, mfa, method: "totp", code: "000000", action: "mfa" });
    assert.equal(wrong.status, 401);

    const ok = await postForm("/oauth/authorize", { request, mfa, method: "totp", code: "123456", action: "mfa" });
    assert.equal(ok.status, 302);
    assert.ok(new URL(ok.headers.get("location")!).searchParams.get("code"));
  });

  it("rejects wrong passwords, disallowed emails and unregistered redirect URIs", async () => {
    const reg = await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const { challenge } = pkce();
    const request = await getRequestToken(authorizeUrl(reg.data.client_id, challenge));

    const wrong = await postForm("/oauth/authorize", { request, email: "admin@shop.com", password: "nope", action: "login" });
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /Invalid email or password/);

    const outsider = await postForm("/oauth/authorize", { request, email: "other@elsewhere.com", password: "secret", action: "login" });
    assert.equal(outsider.status, 403);

    const evil = await fetch(authorizeUrl(reg.data.client_id, challenge, { redirect_uri: "https://evil.example/cb" }));
    assert.equal(evil.status, 400);

    const insecure = await register({ redirect_uris: ["http://evil.example/cb"] });
    assert.equal(insecure.status, 400);
  });

  it("deny redirects back with access_denied", async () => {
    const reg = await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const { challenge } = pkce();
    const request = await getRequestToken(authorizeUrl(reg.data.client_id, challenge));
    const res = await postForm("/oauth/authorize", { request, action: "deny" });
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get("location")!).searchParams.get("error"), "access_denied");
  });

  it("requires PKCE", async () => {
    const reg = await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const url = authorizeUrl(reg.data.client_id, "x");
    url.searchParams.delete("code_challenge");
    const res = await fetch(url, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get("location")!).searchParams.get("error"), "invalid_request");
  });

  it("works end-to-end with the official MCP SDK OAuth client (discovery + DCR + PKCE)", async () => {
    let clientInfo: any;
    let tokens: any;
    let verifier = "";
    let code: string | undefined;
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return REDIRECT;
      },
      get clientMetadata() {
        return { client_name: "SDK client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" };
      },
      clientInformation: () => clientInfo,
      saveClientInformation: (info) => void (clientInfo = info),
      tokens: () => tokens,
      saveTokens: (t) => void (tokens = t),
      saveCodeVerifier: (v) => void (verifier = v),
      codeVerifier: () => verifier,
      redirectToAuthorization: async (authUrl) => {
        // Simulate the user's browser: open the login page, submit credentials, follow the redirect.
        const request = await getRequestToken(authUrl);
        const res = await postForm("/oauth/authorize", { request, email: "admin@shop.com", password: "secret", action: "login" });
        const location = new URL(res.headers.get("location")!);
        assert.equal(location.searchParams.get("iss"), base);
        code = location.searchParams.get("code") ?? undefined;
      },
    };

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
    const first = new Client({ name: "sdk", version: "1" });
    await assert.rejects(first.connect(transport), UnauthorizedError);
    assert.ok(code, "authorization code should have been issued");
    await transport.finishAuth(code!);
    assert.ok(tokens?.access_token);

    const second = new Client({ name: "sdk", version: "1" });
    await second.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
    const { tools } = await second.listTools();
    assert.ok(tools.some((t) => t.name === "medusa_call_operation"));
    await second.close();
  });

  it("static tokens keep working and forged tokens are rejected", async () => {
    const ok = new Client({ name: "t", version: "1" });
    await ok.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${STATIC_TOKEN}` } } }));
    await ok.close();

    const forged = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad" },
      body: "{}",
    });
    assert.equal(forged.status, 401);
    assert.match(forged.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  });
});
