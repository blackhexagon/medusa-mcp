import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { ToolInputError, textResult } from "./tools/execute.js";
import type { ToolDefinition } from "./tools/index.js";
import { VERSION } from "./version.js";

function instructions(config: Config, operationCount: number): string {
  const lines = [
    `This server exposes the Medusa v2 Admin API (${operationCount} operations) of one store.`,
    config.toolMode === "dynamic"
      ? "Workflow: medusa_search_operations (find the endpoint) -> medusa_describe_operation (see params/body) -> medusa_call_operation."
      : "Each Admin API operation is a separate tool; path params are top-level arguments, query params go in `query`, the JSON body in `body`.",
    "Medusa tips:",
    "- List endpoints support `limit`, `offset`, `order` (e.g. \"-created_at\") and return `count`. Keep `limit` small (10-50).",
    "- Use the `fields` query param to select or expand data, e.g. \"id,title,*variants\" or \"+metadata\" (prefix + adds to defaults).",
    "- Many list endpoints accept `q` for free-text search and filter params (ids accept arrays).",
    "- Monetary amounts in Medusa v2 are decimal values in the currency's main unit (e.g. 10.5 = 10.50 EUR), not cents.",
    "- Confirm with the user before destructive operations (DELETE, cancel, refund, etc.).",
  ];
  if (config.readOnly) lines.push("READ-ONLY mode: only GET operations are available.");
  return lines.join("\n");
}

export function createMcpServer(config: Config, tools: ToolDefinition[], operationCount: number): Server {
  const server = new Server(
    { name: config.serverName, title: "Medusa Admin", version: VERSION },
    { capabilities: { tools: {} }, instructions: instructions(config, operationCount) },
  );
  const byName = new Map(tools.map((t) => [t.tool.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((t) => t.tool) }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const def = byName.get(request.params.name);
    if (!def) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    const started = Date.now();
    try {
      const result = await def.handler((request.params.arguments ?? {}) as Record<string, unknown>, extra.signal);
      log.info(`tool ${request.params.name} ${result.isError ? "error" : "ok"} ${Date.now() - started}ms`);
      return result;
    } catch (err) {
      if (err instanceof ToolInputError) return textResult(err.message, true);
      log.error(`tool ${request.params.name} failed`, err);
      return textResult(`Internal error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  return server;
}
