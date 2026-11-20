export type ToolMode = "dynamic" | "full";
export type Transport = "http" | "stdio";

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
  if (transport === "http" && authTokens.length === 0 && !allowUnauthenticated) {
    throw new Error(
      "MCP_AUTH_TOKEN(S) is required for the HTTP transport. Generate one with `openssl rand -hex 32`. " +
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
