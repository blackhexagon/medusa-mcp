# Medusa MCP server

An [MCP](https://modelcontextprotocol.io) server for the **Medusa v2 Admin API**. It covers all 404 Admin operations in the bundled `openapi.yaml` (Medusa 2.22.7). It runs as a Docker container with a Streamable HTTP endpoint protected by a bearer token, so you can deploy one instance per client or store, for example on Dokploy.

- **Full API coverage**: the tools are generated from the OpenAPI spec. Admin routes added later or custom `/admin/*` routes work through raw requests.
- **LLM-friendly**: by default the server exposes only 5 tools (search → describe → call), not 400+. These definitions take about 4 KB of context. The full set would take about 600 KB.
- **Auth on both sides**: the MCP endpoint accepts static bearer tokens and/or **OAuth 2.1**, where users sign in with their Medusa admin account. OAuth is needed for ChatGPT and lets Claude use "Sign in". The server reaches Medusa with a secret API key or an admin email and password.
- **Safety switches**: read-only mode, tag allow-lists and deny-lists, and per-operation deny-lists.

## Tools

| Mode | Tools |
|---|---|
| `dynamic` (default) | `medusa_search_operations`, `medusa_describe_operation`, `medusa_call_operation`, `medusa_get_schema`, `medusa_upload_files` |
| `full` | One tool per operation (e.g. `GetProducts`, `PostOrdersIdCancel`), plus `medusa_get_schema` and `medusa_upload_files`. Combine it with `MEDUSA_INCLUDE_TAGS`. |

`medusa_upload_files` sends `multipart/form-data` to `POST /admin/uploads`. Each file comes from base64 content or a public URL.

## Configuration (env)

| Variable | Default | Description |
|---|---|---|
| `MEDUSA_BASE_URL` | – (required) | Medusa backend URL, e.g. `https://api.shop.com` |
| `MEDUSA_API_KEY` | – | Secret API key (`sk_…`, Admin → Settings → Secret API Keys). Recommended. |
| `MEDUSA_ADMIN_EMAIL` / `MEDUSA_ADMIN_PASSWORD` | – | Used instead of the API key. The server gets a JWT and logs in again when it expires. |
| `MEDUSA_EXTRA_HEADERS` | – | JSON object of extra headers for Medusa requests |
| `MEDUSA_TIMEOUT_MS` | `30000` | Timeout for Medusa requests |
| `MCP_AUTH_TOKENS` | – | Comma-separated static bearer tokens. Use several to rotate tokens or to give each user their own. HTTP mode needs these tokens, OAuth, or both. |
| `MCP_OAUTH_SECRET` | – | Turns on OAuth (≥ 32 chars, `openssl rand -hex 32`). Tokens are signed with it, so changing it signs everyone out. |
| `MCP_PUBLIC_URL` | – | Public origin of this server, e.g. `https://mcp.shop.com`. Required with OAuth; it is used as the issuer. |
| `MCP_OAUTH_ALLOWED_EMAILS` | – | Optional allow-list of admin emails or `@domain` suffixes. If empty, every Medusa admin user can sign in. |
| `MCP_OAUTH_ACCESS_TOKEN_TTL` / `MCP_OAUTH_REFRESH_TOKEN_TTL` | `3600` / `2592000` | Token lifetimes in seconds |
| `MCP_ALLOW_QUERY_TOKEN` | `false` | Also accept `?token=…` in the URL, for clients that cannot set headers |
| `MCP_ALLOW_UNAUTHENTICATED` | `false` | Local testing only |
| `MCP_TOOL_MODE` | `dynamic` | `dynamic` or `full` |
| `MEDUSA_READ_ONLY` | `false` | Allow only GET operations |
| `MEDUSA_INCLUDE_TAGS` | – | e.g. `Products,Orders,Customers,Inventory Items` |
| `MEDUSA_EXCLUDE_TAGS` | – | e.g. `Users,Api Keys,Invites` |
| `MEDUSA_EXCLUDE_OPERATIONS` | – | e.g. `DeleteProductsId,DeleteOrdersId` |
| `MEDUSA_ALLOW_RAW_REQUESTS` | `true` | Allow `method` + `path` calls (only `/admin/*`; the filters above still apply) |
| `MEDUSA_OPENAPI_PATH` | – | Path to your own OpenAPI file (YAML/JSON). Use it for a different Medusa version or for custom routes. |
| `MCP_MAX_RESPONSE_CHARS` | `60000` | Responses longer than this are truncated |
| `MCP_PATH` | `/mcp` | Path of the MCP endpoint |
| `MCP_CORS_ORIGINS` | – | Allowed origins for browser clients (`*` allows all) |
| `MCP_TRANSPORT` | `http` | `http` or `stdio` |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |

`/health` is the health check endpoint. It does not need a token.

## Deploying on Dokploy (one instance per client)

1. In the project, create **Compose** → Raw, then paste [`docker-compose.yml`](docker-compose.yml).
2. In **Environment**, fill in the variables from [`.env.example`](.env.example): `MEDUSA_BASE_URL`, `MEDUSA_API_KEY`, and `MCP_AUTH_TOKENS` and/or `MCP_OAUTH_SECRET` + `MCP_PUBLIC_URL` (generate secrets with `openssl rand -hex 32`).
3. In **Domains**, add a domain for the `medusa-mcp` service on port `3000` with HTTPS.
4. Deploy. The endpoint is `https://<domain>/mcp`.

For another client, create another Compose service with different env values.

## OAuth (ChatGPT, Claude "Sign in")

Set `MCP_OAUTH_SECRET` and `MCP_PUBLIC_URL` to enable OAuth. The server then acts as its own OAuth 2.1 authorization server, following the MCP authorization spec:

- Discovery: `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`. A `401` response includes a `WWW-Authenticate` header with `resource_metadata`.
- Authorization code + PKCE (S256), RFC 9207 `iss` in the redirect, and RFC 8707 `resource` / audience checks
- Client registration: Client ID Metadata Documents (CIMD) and Dynamic Client Registration (`/oauth/register`)
- `/oauth/authorize` shows a login page. The user signs in with their **Medusa admin email and password**, including MFA if it is enabled. The credentials are checked against Medusa and are never stored.
- Tokens are stateless signed JWTs, so there is no database and they survive restarts. A refresh fails once the admin user is deleted in Medusa.

API calls to Medusa still use `MEDUSA_API_KEY`. The OAuth login only decides *who may use* the MCP server, and the logs record which admin called each tool.

**ChatGPT:** Settings → Plugins (or Apps) → *Add custom MCP server* → URL `https://mcp.shop.com/mcp`, Authentication **OAuth**. Leave the client ID and secret empty; ChatGPT registers itself through CIMD or DCR.

**Claude (claude.ai / Desktop):** *Add custom connector* → URL `https://mcp.shop.com/mcp` → **Sign in now** → *Use Claude's published identity* (CIMD) or *Register automatically* (DCR).

## Connecting an MCP client

Claude Code:

```bash
claude mcp add --transport http medusa-shop https://mcp.shop.com/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Cursor, VS Code, and other clients (`mcp.json`):

```json
{
  "mcpServers": {
    "medusa-shop": {
      "url": "https://mcp.shop.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

For clients that cannot send a custom header, set `MCP_ALLOW_QUERY_TOKEN=true` and use `https://mcp.shop.com/mcp?token=<MCP_AUTH_TOKEN>`. The token then shows up in proxy logs, so use a dedicated token for this.

Local stdio (Claude Desktop):

```json
{
  "mcpServers": {
    "medusa": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT=stdio", "-e", "MEDUSA_BASE_URL", "-e", "MEDUSA_API_KEY", "ghcr.io/blackhexagon/medusa-mcp:latest"],
      "env": { "MEDUSA_BASE_URL": "https://api.shop.com", "MEDUSA_API_KEY": "sk_..." }
    }
  }
}
```

## Development

```bash
npm install
npm run build        # openapi.yaml -> generated/spec.json + tsc
npm test             # e2e tests against a mock Medusa server
MEDUSA_BASE_URL=http://localhost:9000 MEDUSA_API_KEY=sk_... MCP_AUTH_TOKENS=dev-token-1234567890 npm run dev
npx @modelcontextprotocol/inspector   # Streamable HTTP, http://localhost:3000/mcp + Authorization header
```

To update the API, replace `openapi.yaml` and run `npm run build`.

## Releases (GHCR)

The GitHub Actions workflow [`.github/workflows/docker.yml`](.github/workflows/docker.yml) builds a multi-arch image (amd64 and arm64) and pushes it to `ghcr.io/<owner>/<repo>`:

- a push to `main` produces `latest` and `sha-xxxxxxx`
- a `v1.2.3` tag produces `1.2.3`, `1.2`, and `1`

After the first push, open GitHub → Packages → the package → *Package settings* and set **visibility to Public**. Otherwise Dokploy needs registry credentials to pull the image.
