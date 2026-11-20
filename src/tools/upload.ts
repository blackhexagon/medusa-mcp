import type { ToolContext, ToolDefinition } from "./index.js";
import { executeRequest, textResult } from "./execute.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

interface FileInput {
  filename?: unknown;
  content_base64?: unknown;
  url?: unknown;
  mime_type?: unknown;
}

/**
 * `POST /admin/uploads` expects multipart/form-data, which cannot be expressed
 * via the generic JSON call tool, so it gets a dedicated tool.
 */
export function uploadTool(ctx: ToolContext): ToolDefinition | undefined {
  if (ctx.config.readOnly || !ctx.catalog.get("PostUploads")) return undefined;

  return {
    tool: {
      name: "medusa_upload_files",
      title: "Upload files to Medusa",
      description:
        "Upload one or more files (e.g. product images) via POST /admin/uploads. Each file is given either as " +
        "base64 `content_base64` or as a public http(s) `url` the server downloads. Returns the uploaded files with their " +
        "`url`, which you can then use e.g. in product `images` / `thumbnail`.",
      inputSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                filename: { type: "string", description: "File name including extension, e.g. \"shirt.jpg\"." },
                content_base64: { type: "string", description: "Base64-encoded file content." },
                url: { type: "string", description: "Public http(s) URL to download the file from." },
                mime_type: { type: "string", description: "MIME type, e.g. \"image/jpeg\". Guessed if omitted." },
              },
              required: ["filename"],
            },
          },
        },
        required: ["files"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler: async (args, signal) => {
      if (!Array.isArray(args.files) || args.files.length === 0) return textResult("`files` must be a non-empty array.", true);
      const form = new FormData();
      for (const raw of args.files as FileInput[]) {
        const filename = typeof raw?.filename === "string" && raw.filename ? raw.filename : undefined;
        if (!filename) return textResult("Every file needs a `filename`.", true);
        let bytes: Uint8Array<ArrayBuffer>;
        let type = typeof raw.mime_type === "string" ? raw.mime_type : undefined;
        if (typeof raw.content_base64 === "string" && raw.content_base64) {
          const b64 = raw.content_base64.replace(/^data:([^;]+);base64,/, (_, t: string) => {
            type ??= t;
            return "";
          });
          bytes = new Uint8Array(Buffer.from(b64, "base64"));
        } else if (typeof raw.url === "string" && raw.url) {
          let url: URL;
          try {
            url = new URL(raw.url);
          } catch {
            return textResult(`Invalid url for ${filename}.`, true);
          }
          if (url.protocol !== "https:" && url.protocol !== "http:") return textResult("Only http(s) URLs are supported.", true);
          const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
          if (!res.ok) return textResult(`Downloading ${url} failed: ${res.status} ${res.statusText}`, true);
          const len = Number(res.headers.get("content-length") ?? 0);
          if (len > MAX_FILE_BYTES) return textResult(`${filename} is larger than ${MAX_FILE_BYTES} bytes.`, true);
          bytes = new Uint8Array(await res.arrayBuffer());
          type ??= res.headers.get("content-type")?.split(";")[0];
        } else {
          return textResult(`File ${filename} needs either content_base64 or url.`, true);
        }
        if (bytes.byteLength === 0) return textResult(`${filename} is empty.`, true);
        if (bytes.byteLength > MAX_FILE_BYTES) return textResult(`${filename} is larger than ${MAX_FILE_BYTES} bytes.`, true);
        form.append("files", new Blob([bytes], { type: type ?? guessMime(filename) }), filename);
      }
      return executeRequest(ctx.client, ctx.config, {
        method: "POST",
        path: "/admin/uploads",
        formData: form,
        label: "PostUploads",
        signal,
      });
    },
  };
}

function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    csv: "text/csv",
    txt: "text/plain",
    json: "application/json",
  };
  return (ext && map[ext]) || "application/octet-stream";
}
