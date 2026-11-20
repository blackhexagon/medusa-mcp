export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type JsonSchema = Record<string, unknown>;

export interface OperationParam {
  name: string;
  in: "path" | "query";
  required: boolean;
  description?: string;
  schema?: JsonSchema;
}

export interface Operation {
  /** OpenAPI operationId, e.g. "GetProducts". */
  id: string;
  method: HttpMethod;
  /** Path template, e.g. "/admin/products/{id}". */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  deprecated?: boolean;
  params: OperationParam[];
  /** JSON request body schema (may contain $refs into `schemas`). */
  body?: JsonSchema;
  bodyRequired?: boolean;
}

export interface CompactSpec {
  title: string;
  version: string;
  operations: Operation[];
  /** components.schemas, cleaned up. */
  schemas: Record<string, JsonSchema>;
}
