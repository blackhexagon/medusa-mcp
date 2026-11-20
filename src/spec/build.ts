import { parse as parseYaml } from "yaml";
import type { CompactSpec, HttpMethod, JsonSchema, Operation, OperationParam } from "./types.js";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Keys that only add noise / tokens for an LLM. */
const DROP_KEYS = new Set(["externalDocs", "title", "example", "examples", "xml"]);

const MAX_DESCRIPTION = 600;

function truncate(text: string | undefined, max = MAX_DESCRIPTION): string | undefined {
  if (!text) return undefined;
  const clean = text.replace(/\s+\n/g, "\n").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Recursively strips vendor extensions and noisy keys from a schema. */
export function cleanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchema);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("x-") || DROP_KEYS.has(key)) continue;
    if (key === "description" && typeof val === "string") {
      out[key] = truncate(val, 300);
      continue;
    }
    // `properties` is a map of names -> schemas; names must never be dropped.
    if (key === "properties" && val && typeof val === "object") {
      const props: Record<string, unknown> = {};
      for (const [prop, schema] of Object.entries(val as Record<string, unknown>)) {
        props[prop] = cleanSchema(schema);
      }
      out[key] = props;
      continue;
    }
    out[key] = cleanSchema(val);
  }
  return out;
}

function resolveParamRef(doc: any, param: any): any {
  if (param && typeof param.$ref === "string") {
    const name = param.$ref.split("/").pop();
    return doc.components?.parameters?.[name] ?? param;
  }
  return param;
}

export function buildCompactSpec(source: string): CompactSpec {
  const doc: any = source.trimStart().startsWith("{") ? JSON.parse(source) : parseYaml(source, { maxAliasCount: -1 });
  if (!doc?.paths) throw new Error("Invalid OpenAPI document: missing `paths`.");

  const operations: Operation[] = [];
  for (const [path, item] of Object.entries<any>(doc.paths)) {
    const sharedParams: any[] = item.parameters ?? [];
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const params: OperationParam[] = [];
      for (const raw of [...sharedParams, ...(op.parameters ?? [])]) {
        const p = resolveParamRef(doc, raw);
        if (p.in !== "path" && p.in !== "query") continue; // headers/cookies are handled by the client
        if (params.some((x) => x.name === p.name && x.in === p.in)) continue;
        params.push({
          name: p.name,
          in: p.in,
          required: p.in === "path" ? true : Boolean(p.required),
          description: truncate(p.description, 300),
          schema: p.schema ? (cleanSchema(p.schema) as JsonSchema) : undefined,
        });
      }
      const jsonBody = op.requestBody?.content?.["application/json"]?.schema;
      operations.push({
        id: op.operationId ?? `${method}_${path}`,
        method: method.toUpperCase() as HttpMethod,
        path,
        tag: op.tags?.[0] ?? "Other",
        summary: op.summary ?? "",
        description: op.description && op.description !== op.summary ? truncate(op.description) : undefined,
        deprecated: op.deprecated || undefined,
        params,
        body: jsonBody ? (cleanSchema(jsonBody) as JsonSchema) : undefined,
        bodyRequired: jsonBody ? Boolean(op.requestBody?.required) || undefined : undefined,
      });
    }
  }

  // Only keep component schemas reachable from request bodies / parameters.
  // Response schemas are not needed: the model sees real responses anyway.
  const allSchemas: Record<string, unknown> = doc.components?.schemas ?? {};
  const schemas: Record<string, JsonSchema> = {};
  const queue: unknown[] = operations.flatMap((o) => [o.body, ...o.params.map((p) => p.schema)]);
  while (queue.length) {
    const node = queue.pop();
    if (Array.isArray(node)) {
      queue.push(...node);
    } else if (node && typeof node === "object") {
      for (const [key, val] of Object.entries(node)) {
        if (key === "$ref" && typeof val === "string") {
          const name = val.split("/").pop()!;
          if (!schemas[name] && allSchemas[name]) {
            schemas[name] = cleanSchema(allSchemas[name]) as JsonSchema;
            queue.push(schemas[name]);
          }
        } else {
          queue.push(val);
        }
      }
    }
  }

  return {
    title: doc.info?.title ?? "Medusa Admin API",
    version: doc.info?.version ?? "unknown",
    operations,
    schemas,
  };
}
