import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import type { OAuthProvider } from "./oauth/provider.js";
import { VERSION } from "./version.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest();

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

function jsonRpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `Request body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

/** Who is calling: a static token, an OAuth user, or nobody (unauthenticated mode). */
export type Caller = { kind: "token" } | { kind: "oauth"; email: string; sub: string } | { kind: "anonymous" };

export function startHttpServer(config: Config, createMcp: (caller: Caller) => McpServer, oauth?: OAuthProvider) {
  const tokenHashes = config.authTokens.map(sha256);

  /** Returns the caller, or `undefined` if unauthorized; `presented` tells whether a credential was sent. */
  const authenticate = (req: IncomingMessage, url: URL): { caller?: Caller; presented: boolean } => {
    let token: string | undefined;
    const header = req.headers.authorization;
    if (header?.toLowerCase().startsWith("bearer ")) token = header.slice(7).trim();
    if (!token && typeof req.headers["x-api-key"] === "string") token = req.headers["x-api-key"].trim();
    if (!token && config.allowQueryToken) token = url.searchParams.get("token") ?? undefined;
    if (!token) {
      const open = tokenHashes.length === 0 && !oauth && config.allowUnauthenticated;
      return { caller: open ? { kind: "anonymous" } : undefined, presented: false };
    }
    if (tokenHashes.length) {
      const candidate = sha256(token);
      // Check every token (no early exit) to keep timing independent of which token matched.
      let ok = false;
      for (const hash of tokenHashes) ok = timingSafeEqual(candidate, hash) || ok;
      if (ok) return { caller: { kind: "token" }, presented: true };
    }
    if (oauth) {
      const identity = oauth.verifyAccessToken(token);
      if (identity) return { caller: { kind: "oauth", email: identity.email, sub: identity.sub }, presented: true };
    }
    return { presented: true };
  };

  const corsHeaders = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    if (!origin || config.corsOrigins.length === 0) return {};
    const allowed = config.corsOrigins.includes("*") || config.corsOrigins.includes(origin);
    if (!allowed) return {};
    return {
      "access-control-allow-origin": config.corsOrigins.includes("*") ? "*" : origin,
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers":
        "authorization, content-type, x-api-key, mcp-protocol-version, mcp-session-id, last-event-id",
      "access-control-expose-headers": "mcp-session-id, www-authenticate",
      "access-control-max-age": "86400",
      vary: "origin",
    };
  };

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cors = corsHeaders(req);
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

    try {
      // OAuth / well-known routes handle their own CORS (public metadata + token endpoint).
      if (oauth && (await oauth.handle(req, res, url))) return;

      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      if (url.pathname === "/health" || url.pathname === "/healthz") {
        sendJson(res, 200, { status: "ok", version: VERSION });
        return;
      }

      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (path !== config.mcpPath) {
        if (path === "/" && req.method === "GET") {
          sendJson(res, 200, { name: "medusa-mcp", version: VERSION, mcp_endpoint: config.mcpPath });
          return;
        }
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      const { caller, presented } = authenticate(req, url);
      if (!caller) {
        if (presented) log.warn(`Rejected invalid token from ${req.socket.remoteAddress}`);
        jsonRpcError(res, 401, "Unauthorized: missing or invalid bearer token", {
          "www-authenticate": oauth ? oauth.challenge(presented ? "invalid_token" : undefined) : 'Bearer realm="medusa-mcp"',
        });
        return;
      }

      if (req.method !== "POST") {
        // Stateless server: no standalone SSE stream and no sessions to delete.
        jsonRpcError(res, 405, "Method not allowed", { allow: "POST, OPTIONS" });
        return;
      }

      const body = await readBody(req, config.maxBodyBytes);
      const mcp = createMcp(caller);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (err instanceof HttpError) {
        jsonRpcError(res, err.status, err.message);
      } else {
        log.error("Unhandled HTTP error", err);
        jsonRpcError(res, 500, "Internal server error");
      }
    }
  });

  httpServer.listen(config.port, config.host, () => {
    log.info(`medusa-mcp ${VERSION} listening on http://${config.host}:${config.port}${config.mcpPath}`);
    if (oauth) log.info(`OAuth enabled: issuer ${oauth.issuer}, resource ${oauth.resource}`);
    if (tokenHashes.length === 0 && !oauth) log.warn("MCP endpoint is UNAUTHENTICATED (MCP_ALLOW_UNAUTHENTICATED=true)");
  });

  const shutdown = (signal: string) => {
    log.info(`${signal} received, shutting down`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return httpServer;
}
