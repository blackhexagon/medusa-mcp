export type ToolMode = "dynamic" | "full";
export type Transport = "http" | "stdio";

export interface OAuthConfig {
  secret: string;
  /** Public origin of this server, e.g. https://mcp.example.com (used as OAuth issuer). */
  publicUrl: string;
  accessTokenTtl: number;
  refreshTokenTtl: number;
  /** Allowed admin emails or "@domain" suffixes. Empty => every Medusa admin user. */
  allowedEmails: string[];
}

export interface Config {
  transport: Transport;
  host: string;
  port: number;
  mcpPath: string;
  /** Accepted bearer tokens for the MCP endpoint. Empty => unauthenticated (only if explicitly allowed). */
  authTokens: string[];
  allowUnauthenticated: boolean;
  allowQueryToken: boolean;
  corsOrigins: string[];
  maxBodyBytes: number;

  /** OAuth 2.1 authorization server (login with a Medusa admin account). Enabled when `oauth` is set. */
  oauth?: OAuthConfig;

  medusaBaseUrl: string;
  medusaApiKey?: string;
  medusaEmail?: string;
  medusaPassword?: string;
  medusaTimeoutMs: number;
  medusaExtraHeaders: Record<string, string>;

  toolMode: ToolMode;
  readOnly: boolean;
  includeTags: string[];
  excludeTags: string[];
  excludeOperations: string[];
  allowRawRequests: boolean;
  maxResponseChars: number;
  openapiPath?: string;
  serverName: string;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${value}"`);
  return n;
}

function headers(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    }
  } catch {
    // fall through
  }
  throw new Error('MEDUSA_EXTRA_HEADERS must be a JSON object, e.g. {"x-publishable-api-key":"pk_..."}');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const transport = (env.MCP_TRANSPORT ?? "http").toLowerCase();
  if (transport !== "http" && transport !== "stdio") throw new Error(`MCP_TRANSPORT must be "http" or "stdio"`);

  const toolMode = (env.MCP_TOOL_MODE ?? "dynamic").toLowerCase();
  if (toolMode !== "dynamic" && toolMode !== "full") throw new Error(`MCP_TOOL_MODE must be "dynamic" or "full"`);

  const medusaBaseUrl = (env.MEDUSA_BASE_URL ?? env.MEDUSA_BACKEND_URL ?? "").replace(/\/+$/, "");
  if (!medusaBaseUrl) throw new Error("MEDUSA_BASE_URL is required (e.g. https://api.my-shop.com)");
  try {
    new URL(medusaBaseUrl);
  } catch {
    throw new Error(`MEDUSA_BASE_URL is not a valid URL: ${medusaBaseUrl}`);
  }

  const medusaApiKey = env.MEDUSA_API_KEY || undefined;
  const medusaEmail = env.MEDUSA_ADMIN_EMAIL || undefined;
  const medusaPassword = env.MEDUSA_ADMIN_PASSWORD || undefined;
  if (!medusaApiKey && !(medusaEmail && medusaPassword)) {
    throw new Error("Set MEDUSA_API_KEY (secret API key, recommended) or MEDUSA_ADMIN_EMAIL + MEDUSA_ADMIN_PASSWORD.");
  }

  const authTokens = list(env.MCP_AUTH_TOKENS ?? env.MCP_AUTH_TOKEN);
  const allowUnauthenticated = bool(env.MCP_ALLOW_UNAUTHENTICATED, false);
  const oauth = loadOAuthConfig(env);
  if (transport === "http" && authTokens.length === 0 && !oauth && !allowUnauthenticated) {
    throw new Error(
      "The HTTP transport needs authentication: set MCP_AUTH_TOKENS (generate with `openssl rand -hex 32`) " +
        "and/or enable OAuth with MCP_OAUTH_SECRET + MCP_PUBLIC_URL. " +
        "(Set MCP_ALLOW_UNAUTHENTICATED=true only for local testing.)",
    );
  }
  for (const token of authTokens) {
    if (token.length < 16) throw new Error("Each MCP auth token must be at least 16 characters long.");
  }

  let mcpPath = env.MCP_PATH ?? "/mcp";
  if (!mcpPath.startsWith("/")) mcpPath = `/${mcpPath}`;

  return {
    transport,
    host: env.HOST ?? "0.0.0.0",
    port: int(env.PORT, 3000, "PORT"),
    mcpPath: mcpPath.replace(/\/+$/, "") || "/mcp",
    authTokens,
    allowUnauthenticated,
    allowQueryToken: bool(env.MCP_ALLOW_QUERY_TOKEN, false),
    corsOrigins: list(env.MCP_CORS_ORIGINS),
    maxBodyBytes: int(env.MCP_MAX_BODY_BYTES, 20 * 1024 * 1024, "MCP_MAX_BODY_BYTES"),
    oauth,

    medusaBaseUrl,
    medusaApiKey,
    medusaEmail,
    medusaPassword,
    medusaTimeoutMs: int(env.MEDUSA_TIMEOUT_MS, 30_000, "MEDUSA_TIMEOUT_MS"),
    medusaExtraHeaders: headers(env.MEDUSA_EXTRA_HEADERS),

    toolMode,
    readOnly: bool(env.MEDUSA_READ_ONLY, false),
    includeTags: list(env.MEDUSA_INCLUDE_TAGS),
    excludeTags: list(env.MEDUSA_EXCLUDE_TAGS),
    excludeOperations: list(env.MEDUSA_EXCLUDE_OPERATIONS),
    allowRawRequests: bool(env.MEDUSA_ALLOW_RAW_REQUESTS, true),
    maxResponseChars: int(env.MCP_MAX_RESPONSE_CHARS, 60_000, "MCP_MAX_RESPONSE_CHARS"),
    openapiPath: env.MEDUSA_OPENAPI_PATH || undefined,
    serverName: env.MCP_SERVER_NAME || "medusa-admin",
  };
}

function loadOAuthConfig(env: NodeJS.ProcessEnv): OAuthConfig | undefined {
  const secret = env.MCP_OAUTH_SECRET;
  if (!secret) return undefined;
  if (secret.length < 32) throw new Error("MCP_OAUTH_SECRET must be at least 32 characters (use `openssl rand -hex 32`).");
  const raw = env.MCP_PUBLIC_URL;
  if (!raw) throw new Error("MCP_PUBLIC_URL is required when OAuth is enabled (e.g. https://mcp.example.com).");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`MCP_PUBLIC_URL is not a valid URL: ${raw}`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) throw new Error("MCP_PUBLIC_URL must use https.");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("MCP_PUBLIC_URL must be an origin without a path, e.g. https://mcp.example.com");
  }
  return {
    secret,
    publicUrl: url.origin,
    accessTokenTtl: int(env.MCP_OAUTH_ACCESS_TOKEN_TTL, 3600, "MCP_OAUTH_ACCESS_TOKEN_TTL"),
    refreshTokenTtl: int(env.MCP_OAUTH_REFRESH_TOKEN_TTL, 30 * 24 * 3600, "MCP_OAUTH_REFRESH_TOKEN_TTL"),
    allowedEmails: list(env.MCP_OAUTH_ALLOWED_EMAILS).map((e) => e.toLowerCase()),
  };
}
