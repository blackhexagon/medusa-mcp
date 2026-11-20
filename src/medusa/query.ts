/**
 * Serializes a query object the way Medusa (express + qs) expects it:
 *   { fields: "id,title", id: ["a","b"], created_at: { $gt: "2024-01-01" } }
 *   -> fields=id%2Ctitle&id[0]=a&id[1]=b&created_at[$gt]=2024-01-01
 */
export function toQueryString(query: Record<string, unknown>): string {
  const parts: string[] = [];
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => add(`${key}[${i}]`, v));
    } else if (value instanceof Date) {
      parts.push(`${encodeKey(key)}=${encodeURIComponent(value.toISOString())}`);
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) add(`${key}[${k}]`, v);
    } else {
      parts.push(`${encodeKey(key)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [k, v] of Object.entries(query)) add(k, v);
  return parts.join("&");
}

function encodeKey(key: string): string {
  // Keep brackets and `$` readable; qs decodes both forms.
  return encodeURIComponent(key).replace(/%5B/g, "[").replace(/%5D/g, "]").replace(/%24/g, "$");
}
