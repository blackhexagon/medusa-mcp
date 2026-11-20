import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import { MedusaError, type MedusaClient } from "../medusa/client.js";
import type { Operation } from "../spec/types.js";

export class ToolInputError extends Error {}

export function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

export function buildPath(op: Operation, pathParams: Record<string, unknown>): string {
  return op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = pathParams[name];
    if (value === undefined || value === null || value === "") {
      throw new ToolInputError(`Missing required path parameter "${name}" for ${op.id} (${op.method} ${op.path}).`);
    }
    return encodeURIComponent(String(value));
  });
}

function formatData(data: unknown, maxChars: number): string {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  if (text === undefined) return "null";
  if (maxChars > 0 && text.length > maxChars) {
    return (
      `${text.slice(0, maxChars)}\n\n[TRUNCATED: response was ${text.length} characters, showing the first ${maxChars}. ` +
      `Use a smaller "limit", pagination ("offset"), or the "fields" query parameter to select only the fields you need.]`
    );
  }
  return text;
}

export interface ExecuteInput {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  formData?: FormData;
  label: string;
  signal?: AbortSignal;
}

export async function executeRequest(client: MedusaClient, config: Config, input: ExecuteInput): Promise<CallToolResult> {
  try {
    const res = await client.request({
      method: input.method,
      path: input.path,
      query: input.query,
      body: input.body,
      formData: input.formData,
      signal: input.signal,
    });
    const header = `${input.method.toUpperCase()} ${input.path} -> ${res.status} ${res.statusText}`.trim();
    if (!res.ok) {
      return textResult(`Medusa API error (${input.label})\n${header}\n${formatData(res.data, config.maxResponseChars)}`, true);
    }
    return textResult(res.data === null ? `${header} (no content)` : formatData(res.data, config.maxResponseChars));
  } catch (err) {
    if (err instanceof MedusaError || err instanceof ToolInputError) return textResult(err.message, true);
    throw err;
  }
}

export function asObject(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    // Some clients send nested objects as JSON strings.
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new ToolInputError(`"${name}" must be an object.`);
}

export function parseBody(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}
