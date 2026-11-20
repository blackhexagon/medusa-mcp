import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { buildCompactSpec } from "./build.js";
import type { CompactSpec, JsonSchema, Operation } from "./types.js";

/** Routes under /auth are about logging in; the MCP server handles Medusa auth itself. */
const ALWAYS_EXCLUDED_PREFIXES = ["/auth/"];

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function loadSpec(config: Pick<Config, "openapiPath">): CompactSpec {
  if (config.openapiPath) {
    return buildCompactSpec(readFileSync(config.openapiPath, "utf8"));
  }
  const candidates = [
    new URL("../../generated/spec.json", import.meta.url), // dist/spec -> generated, src/spec -> generated
  ];
  for (const url of candidates) {
    const file = fileURLToPath(url);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as CompactSpec;
  }
  throw new Error("generated/spec.json not found. Run `npm run build:spec` or set MEDUSA_OPENAPI_PATH.");
}

export class Catalog {
  readonly operations: Operation[];
  private readonly byId = new Map<string, Operation>();
  private readonly byIdLower = new Map<string, Operation>();

  constructor(
    readonly spec: CompactSpec,
    filters: Pick<Config, "readOnly" | "includeTags" | "excludeTags" | "excludeOperations">,
  ) {
    const include = new Set(filters.includeTags.map(norm));
    const exclude = new Set(filters.excludeTags.map(norm));
    const excludeOps = new Set(filters.excludeOperations.map((s) => s.toLowerCase()));

    this.operations = spec.operations.filter((op) => {
      if (ALWAYS_EXCLUDED_PREFIXES.some((p) => op.path.startsWith(p))) return false;
      if (filters.readOnly && op.method !== "GET") return false;
      if (include.size && !include.has(norm(op.tag))) return false;
      if (exclude.has(norm(op.tag))) return false;
      if (excludeOps.has(op.id.toLowerCase())) return false;
      return true;
    });
    for (const op of this.operations) {
      this.byId.set(op.id, op);
      this.byIdLower.set(op.id.toLowerCase(), op);
    }
  }

  get(id: string): Operation | undefined {
    return this.byId.get(id) ?? this.byIdLower.get(id.trim().toLowerCase());
  }

  tags(): { tag: string; operations: number }[] {
    const counts = new Map<string, number>();
    for (const op of this.operations) counts.set(op.tag, (counts.get(op.tag) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tag, operations]) => ({ tag, operations }));
  }

  /** Finds an operation whose path template matches a concrete path. */
  matchPath(method: string, path: string): Operation | undefined {
    const m = method.toUpperCase();
    return this.spec.operations.find((op) => {
      if (op.method !== m) return false;
      const re = new RegExp(`^${op.path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]+\\?\}/g, "[^/]+")}$`);
      return re.test(path);
    });
  }

  search(opts: { query?: string; tag?: string; method?: string; limit?: number }): Operation[] {
    let ops = this.operations;
    if (opts.tag) {
      const t = norm(opts.tag);
      ops = ops.filter((o) => norm(o.tag) === t || norm(o.tag).includes(t));
    }
    if (opts.method) {
      const m = opts.method.toUpperCase();
      ops = ops.filter((o) => o.method === m);
    }
    const limit = opts.limit ?? 30;
    if (!opts.query?.trim()) return ops.slice(0, limit);

    const terms = norm(opts.query)
      .split(" ")
      .filter(Boolean)
      .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t)); // naive singularization
    const scored = ops
      .map((op) => {
        const id = norm(op.id.replace(/([a-z])([A-Z])/g, "$1 $2"));
        const summary = norm(op.summary);
        const path = norm(op.path);
        const tag = norm(op.tag);
        const desc = norm(op.description ?? "");
        let score = 0;
        let matched = 0;
        for (const term of terms) {
          let s = 0;
          if (summary.includes(term)) s += 4;
          if (tag.includes(term)) s += 3;
          if (path.includes(term)) s += 2;
          if (id.includes(term)) s += 2;
          if (desc.includes(term)) s += 1;
          if (s > 0) matched++;
          score += s;
        }
        // At least half of the terms must match; operations matching all terms rank first.
        if (matched === 0 || matched < Math.ceil(terms.length / 2)) return { op, score: -1 };
        score += matched * 10;
        // Prefer exact / shorter summaries ("List Orders" over "List Draft Orders") and central endpoints.
        const summaryWords = summary.split(" ").filter(Boolean).length;
        score -= Math.max(0, summaryWords - terms.length) * 0.5;
        score -= op.path.split("/").length * 0.1;
        return { op, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.op);
  }

  schema(name: string): JsonSchema | undefined {
    return this.spec.schemas[name];
  }

  /**
   * One-line, human readable type signature of a schema, e.g.
   * `string | string[]` or `object{$gt,$lt,$eq,…}`. Used for query params,
   * whose full schemas (recursive $and/$or filters) would be enormous.
   */
  signature(schema: unknown, depth = 0): string {
    if (!schema || typeof schema !== "object") return "any";
    const s = schema as Record<string, any>;
    if (typeof s.$ref === "string") {
      const name = s.$ref.split("/").pop()!;
      return depth > 1 || !this.spec.schemas[name] ? name : this.signature(this.spec.schemas[name], depth + 1);
    }
    const variants = s.oneOf ?? s.anyOf;
    if (Array.isArray(variants)) {
      const parts = [...new Set(variants.map((v: unknown) => this.signature(v, depth + 1)))];
      return parts.join(" | ");
    }
    if (Array.isArray(s.allOf)) return s.allOf.map((v: unknown) => this.signature(v, depth + 1)).join(" & ");
    if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
    if (s.type === "array") return `${this.signature(s.items, depth + 1)}[]`;
    if (s.type === "object" || s.properties) {
      const keys = Object.keys(s.properties ?? {});
      if (!keys.length) return "object";
      if (depth > 1) return "object";
      const shown = keys.slice(0, 12).map((k) => (depth === 0 ? `${k}: ${this.signature(s.properties[k], depth + 1)}` : k));
      return `{${shown.join(", ")}${keys.length > 12 ? ", …" : ""}}`;
    }
    return typeof s.type === "string" ? s.type : "any";
  }

  /**
   * Inlines `$ref`s up to `maxDepth` levels. Deeper / recursive references are
   * left as `{ "$ref": "Name" }` hints that can be fetched with the schema tool.
   */
  resolve(schema: unknown, maxDepth = 4): unknown {
    const walk = (node: unknown, depth: number, stack: string[]): unknown => {
      if (Array.isArray(node)) return node.map((n) => walk(n, depth, stack));
      if (!node || typeof node !== "object") return node;
      const obj = node as Record<string, unknown>;
      if (typeof obj.$ref === "string") {
        const name = obj.$ref.split("/").pop()!;
        const target = this.spec.schemas[name];
        if (!target || depth >= maxDepth || stack.includes(name)) {
          return { $ref: name, description: `Schema "${name}" (use medusa_get_schema to expand)` };
        }
        return walk(target, depth + 1, [...stack, name]);
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = walk(v, depth, stack);
      return out;
    };
    return walk(schema, 0, []);
  }
}
