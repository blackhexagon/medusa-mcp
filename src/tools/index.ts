import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import type { MedusaClient } from "../medusa/client.js";
import type { Catalog } from "../spec/catalog.js";
import type { JsonSchema, Operation } from "../spec/types.js";
import { ToolInputError, asObject, buildPath, executeRequest, parseBody, textResult } from "./execute.js";
import { uploadTool } from "./upload.js";

export interface ToolContext {
  config: Config;
  catalog: Catalog;
  client: MedusaClient;
}

export interface ToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>;
}

const MAX_TOOL_NAME = 64;

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function annotationsFor(method: string): Tool["annotations"] {
  return {
    readOnlyHint: method === "GET",
    destructiveHint: method === "DELETE",
    idempotentHint: method === "GET" || method === "DELETE",
    openWorldHint: true,
  };
}

function opLine(op: Operation): string {
  return `${op.id} | ${op.method} ${op.path} | ${op.summary}${op.deprecated ? " (deprecated)" : ""}`;
}

/** Compact, LLM-friendly description of an operation. */
export function describeOperation(catalog: Catalog, op: Operation): Record<string, unknown> {
  const pathParams = op.params.filter((p) => p.in === "path");
  const queryParams = op.params.filter((p) => p.in === "query");
  return {
    operation_id: op.id,
    method: op.method,
    path: op.path,
    tag: op.tag,
    summary: op.summary,
    description: op.description,
    deprecated: op.deprecated,
    path_params: pathParams.map((p) => ({ name: p.name, description: p.description })),
    query_params: queryParams.map((p) => ({
      name: p.name,
      required: p.required || undefined,
      type: truncateText(catalog.signature(p.schema), 300),
      description: p.description,
    })),
    body_required: op.bodyRequired,
    body_schema: op.body ? catalog.resolve(op.body, 3) : undefined,
  };
}

async function callOperation(ctx: ToolContext, op: Operation, args: Record<string, unknown>, signal: AbortSignal) {
  const pathParams = { ...args, ...(asObject(args.path_params, "path_params") ?? {}) };
  const path = buildPath(op, pathParams);
  const body = parseBody(args.body);
  if (op.bodyRequired && body === undefined) {
    throw new ToolInputError(
      `${op.id} requires a request body. Use medusa_describe_operation("${op.id}") to see its body schema.`,
    );
  }
  return executeRequest(ctx.client, ctx.config, {
    method: op.method,
    path,
    query: asObject(args.query, "query"),
    body: op.method === "GET" ? undefined : body,
    label: op.id,
    signal,
  });
}

// ---------------------------------------------------------------------------
// Dynamic mode: a handful of meta-tools that cover every operation.
// ---------------------------------------------------------------------------

function dynamicTools(ctx: ToolContext): ToolDefinition[] {
  const { catalog, config } = ctx;
  const tools: ToolDefinition[] = [];

  tools.push({
    tool: {
      name: "medusa_search_operations",
      title: "Search Medusa Admin API operations",
      description:
        "Find Medusa Admin API operations (endpoints). Call without arguments to list all resource tags. " +
        "Filter by `tag` (e.g. \"Products\", \"Orders\") and/or free-text `query` (e.g. \"cancel order\", \"variant inventory\"). " +
        "Returns lines `operation_id | METHOD path | summary`. Next step: medusa_describe_operation for parameters/body, then medusa_call_operation.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search, e.g. \"create product\" or \"fulfillment\"." },
          tag: { type: "string", description: "Resource tag, e.g. \"Products\", \"Orders\", \"Customers\"." },
          method: { type: "string", enum: ["GET", "POST", "DELETE"], description: "Optional HTTP method filter." },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 30 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (args) => {
      const query = typeof args.query === "string" ? args.query : undefined;
      const tag = typeof args.tag === "string" ? args.tag : undefined;
      const method = typeof args.method === "string" ? args.method : undefined;
      if (!query && !tag && !method) {
        const lines = catalog.tags().map((t) => `${t.tag} (${t.operations})`);
        return textResult(
          `Medusa Admin API ${catalog.spec.version} - ${catalog.operations.length} operations` +
            `${config.readOnly ? " (READ-ONLY mode)" : ""}.\nTags:\n${lines.join("\n")}\n\n` +
            "Call again with `tag` and/or `query` to list operations.",
        );
      }
      const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 200) : 30;
      const ops = catalog.search({ query, tag, method, limit });
      if (!ops.length) {
        return textResult("No matching operations. Call without arguments to see all tags, or try different keywords.");
      }
      return textResult(ops.map(opLine).join("\n"));
    },
  });

  tools.push({
    tool: {
      name: "medusa_describe_operation",
      title: "Describe a Medusa Admin API operation",
      description:
        "Get full details of one operation: path params, query params and the JSON body schema. " +
        "Always call this before medusa_call_operation for POST/DELETE operations you have not used yet.",
      inputSchema: {
        type: "object",
        properties: {
          operation_id: { type: "string", description: "Operation id from medusa_search_operations, e.g. \"PostProducts\"." },
        },
        required: ["operation_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (args) => {
      const op = catalog.get(String(args.operation_id ?? ""));
      if (!op) return textResult(`Unknown operation "${args.operation_id}". Use medusa_search_operations.`, true);
      return textResult(JSON.stringify(describeOperation(catalog, op)));
    },
  });

  tools.push(schemaTool(ctx));

  const callDescription =
    "Call a Medusa Admin API operation by `operation_id` (preferred) with `path_params`, `query` and `body`." +
    (config.allowRawRequests ? " Alternatively pass `method` + `path` (must start with /admin/) for custom routes not in the catalog." : "") +
    " Tips: use query.fields to select/expand fields (e.g. \"*variants,+metadata\"), query.limit/offset for pagination, " +
    "and filters like query.q for search. Returns the raw JSON response." +
    (config.readOnly ? " READ-ONLY mode: only GET requests are allowed." : "");

  tools.push({
    tool: {
      name: "medusa_call_operation",
      title: "Call a Medusa Admin API operation",
      description: callDescription,
      inputSchema: {
        type: "object",
        properties: {
          operation_id: { type: "string", description: "Operation id, e.g. \"GetProducts\" or \"PostOrdersIdCancel\"." },
          path_params: {
            type: "object",
            description: "Values for {placeholders} in the path, e.g. {\"id\": \"prod_123\"}.",
            additionalProperties: true,
          },
          query: {
            type: "object",
            description: "Query string parameters. Arrays and nested objects are supported (e.g. {\"id\": [\"a\",\"b\"]}).",
            additionalProperties: true,
          },
          body: { type: "object", description: "JSON request body (POST operations).", additionalProperties: true },
          ...(config.allowRawRequests
            ? {
                method: { type: "string", enum: config.readOnly ? ["GET"] : ["GET", "POST", "DELETE"] },
                path: { type: "string", description: "Concrete path for raw requests, e.g. /admin/custom/route." },
              }
            : {}),
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: config.readOnly,
        destructiveHint: !config.readOnly,
        openWorldHint: true,
      },
    },
    handler: async (args, signal) => {
      if (typeof args.operation_id === "string" && args.operation_id) {
        const op = catalog.get(args.operation_id);
        if (!op) {
          return textResult(
            `Unknown or disabled operation "${args.operation_id}". Use medusa_search_operations to find valid ids.`,
            true,
          );
        }
        return callOperation(ctx, op, { ...args, operation_id: undefined }, signal);
      }

      if (!config.allowRawRequests) return textResult("`operation_id` is required.", true);
      const method = String(args.method ?? "").toUpperCase();
      const path = String(args.path ?? "");
      if (!method || !path) return textResult("Provide `operation_id`, or `method` + `path`.", true);
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return textResult(`Invalid method "${method}".`, true);
      if (!/^\/admin(\/|$)/.test(path) || path.includes("..") || path.includes("?") || path.includes("#")) {
        return textResult("`path` must start with /admin/ and must not contain '..', '?' or '#'. Put query params in `query`.", true);
      }
      if (config.readOnly && method !== "GET") return textResult("Server is in READ-ONLY mode: only GET is allowed.", true);
      // Enforce the same include/exclude filters for raw requests that hit known operations.
      const known = catalog.matchPath(method, path);
      if (known && !catalog.get(known.id)) {
        return textResult(`Operation ${known.id} (${method} ${known.path}) is disabled on this server.`, true);
      }
      return executeRequest(ctx.client, config, {
        method,
        path,
        query: asObject(args.query, "query"),
        body: method === "GET" ? undefined : parseBody(args.body),
        label: `${method} ${path}`,
        signal,
      });
    },
  });

  return tools;
}

// ---------------------------------------------------------------------------
// Full mode: one MCP tool per operation (use MEDUSA_INCLUDE_TAGS to keep the list small).
// ---------------------------------------------------------------------------

function toolNameFor(op: Operation, used: Set<string>): string {
  let name = op.id.replace(/[^A-Za-z0-9_-]/g, "_");
  if (name.length > MAX_TOOL_NAME) name = name.slice(0, MAX_TOOL_NAME);
  let candidate = name;
  for (let i = 2; used.has(candidate); i++) candidate = `${name.slice(0, MAX_TOOL_NAME - String(i).length - 1)}_${i}`;
  used.add(candidate);
  return candidate;
}

function fullTools(ctx: ToolContext): ToolDefinition[] {
  const { catalog } = ctx;
  const used = new Set<string>();
  const tools: ToolDefinition[] = catalog.operations.map((op) => {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const p of op.params.filter((x) => x.in === "path")) {
      properties[p.name] = { type: "string", description: p.description ?? `Path parameter ${p.name}` };
      required.push(p.name);
    }
    const queryParams = op.params.filter((x) => x.in === "query");
    if (queryParams.length) {
      const qProps: Record<string, unknown> = {};
      for (const p of queryParams) {
        const type = p.schema?.type;
        const simple = typeof type === "string" && ["string", "number", "integer", "boolean"].includes(type);
        // Complex filter schemas (recursive $and/$or) are summarized to keep the tool list small.
        qProps[p.name] = simple
          ? { type, ...(p.schema?.enum ? { enum: p.schema.enum } : {}), description: p.description }
          : { description: `${p.description ?? p.name} Type: ${truncateText(catalog.signature(p.schema), 300)}` };
      }
      properties.query = { type: "object", description: "Query parameters.", properties: qProps, additionalProperties: true };
    }
    if (op.body) {
      properties.body = { ...(catalog.resolve(op.body, 2) as JsonSchema), description: "JSON request body." };
      if (op.bodyRequired) required.push("body");
    }
    const description = [`${op.summary} (${op.method} ${op.path})`, op.description].filter(Boolean).join("\n");
    return {
      tool: {
        name: toolNameFor(op, used),
        title: op.summary || op.id,
        description,
        inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
        annotations: annotationsFor(op.method),
      },
      handler: (args, signal) => callOperation(ctx, op, args, signal),
    };
  });
  tools.push(schemaTool(ctx));
  return tools;
}

function schemaTool(ctx: ToolContext): ToolDefinition {
  return {
    tool: {
      name: "medusa_get_schema",
      title: "Get a Medusa schema definition",
      description: "Expand a named schema referenced as {\"$ref\": \"Name\"} in an operation's body or query schema.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Schema name, e.g. \"AdminCreateProduct\"." } },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: async (args) => {
      const name = String(args.name ?? "").replace(/^#\/components\/schemas\//, "");
      const schema = ctx.catalog.schema(name);
      if (!schema) return textResult(`Unknown schema "${name}".`, true);
      return textResult(JSON.stringify(ctx.catalog.resolve(schema, 2), null, 1));
    },
  };
}

export function buildTools(ctx: ToolContext): ToolDefinition[] {
  const tools = ctx.config.toolMode === "full" ? fullTools(ctx) : dynamicTools(ctx);
  const upload = uploadTool(ctx);
  if (upload) tools.push(upload);
  return tools;
}
