import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http.js";
import { MedusaClient } from "../src/medusa/client.js";
import { toQueryString } from "../src/medusa/query.js";
import { createMcpServer } from "../src/server.js";
import { Catalog, loadSpec } from "../src/spec/catalog.js";
import { buildTools } from "../src/tools/index.js";

const TOKEN = "test-token-0123456789abcdef";
const API_KEY = "sk_test_123";

interface Seen {
  method: string;
  url: string;
  auth?: string;
  contentType?: string;
  body: string;
}

let medusa: Server;
let mcpHttp: Server;
let mcpUrl: URL;
const seen: Seen[] = [];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function connect(token?: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

function text(result: any): string {
  return result.content.map((c: any) => c.text).join("\n");
}

before(async () => {
  medusa = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.push({
      method: req.method!,
      url: req.url!,
      auth: req.headers.authorization,
      contentType: req.headers["content-type"],
      body: Buffer.concat(chunks).toString(),
    });
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/admin/products/missing")) {
      res.writeHead(404).end(JSON.stringify({ type: "not_found", message: "Product not found" }));
      return;
    }
    res.end(JSON.stringify({ ok: true, method: req.method, url: req.url }));
  });
  const medusaPort = await listen(medusa);

  const config = loadConfig({
    MEDUSA_BASE_URL: `http://127.0.0.1:${medusaPort}`,
    MEDUSA_API_KEY: API_KEY,
    MCP_AUTH_TOKENS: TOKEN,
    PORT: "0",
    HOST: "127.0.0.1",
  });
  const catalog = new Catalog(loadSpec(config), config);
  const client = new MedusaClient(config);
  const tools = buildTools({ config, catalog, client });
  mcpHttp = startHttpServer(config, () => createMcpServer(config, tools, catalog.operations.length));
  await new Promise<void>((resolve) => (mcpHttp.listening ? resolve() : mcpHttp.once("listening", resolve)));
  mcpUrl = new URL(`http://127.0.0.1:${(mcpHttp.address() as AddressInfo).port}/mcp`);
});

after(() => {
  mcpHttp?.close();
  medusa?.close();
});

describe("auth", () => {
  it("rejects requests without a token", async () => {
    await assert.rejects(connect());
    const res = await fetch(mcpUrl, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(res.status, 401);
  });

  it("rejects a wrong token", async () => {
    await assert.rejects(connect("wrong-token-wrong-token"));
  });

  it("exposes an unauthenticated health check", async () => {
    const res = await fetch(new URL("/health", mcpUrl));
    assert.equal(res.status, 200);
  });
});

describe("dynamic tools", () => {
  it("lists the meta tools", async () => {
    const client = await connect(TOKEN);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["medusa_call_operation", "medusa_describe_operation", "medusa_get_schema", "medusa_search_operations", "medusa_upload_files"],
    );
    await client.close();
  });

  it("searches and describes operations", async () => {
    const client = await connect(TOKEN);
    const tags = text(await client.callTool({ name: "medusa_search_operations", arguments: {} }));
    assert.match(tags, /Products \(\d+\)/);
    assert.doesNotMatch(tags, /Multi-Factor/);

    const found = text(await client.callTool({ name: "medusa_search_operations", arguments: { query: "cancel order" } }));
    assert.match(found, /PostOrdersIdCancel/);

    const desc = JSON.parse(
      text(await client.callTool({ name: "medusa_describe_operation", arguments: { operation_id: "PostProducts" } })),
    );
    assert.equal(desc.path, "/admin/products");
    assert.ok(JSON.stringify(desc.body_schema).includes("title"));
    await client.close();
  });

  it("calls an operation with path params, query and body", async () => {
    const client = await connect(TOKEN);
    seen.length = 0;
    const res: any = await client.callTool({
      name: "medusa_call_operation",
      arguments: {
        operation_id: "PostProductsId",
        path_params: { id: "prod_1" },
        query: { fields: "id,title" },
        body: { title: "New" },
      },
    });
    assert.ok(!res.isError, text(res));
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/admin/products/prod_1?fields=id%2Ctitle");
    assert.equal(seen[0].auth, `Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`);
    assert.deepEqual(JSON.parse(seen[0].body), { title: "New" });
    await client.close();
  });

  it("returns Medusa errors as tool errors", async () => {
    const client = await connect(TOKEN);
    const res: any = await client.callTool({
      name: "medusa_call_operation",
      arguments: { operation_id: "GetProductsId", path_params: { id: "missing" } },
    });
    assert.equal(res.isError, true);
    assert.match(text(res), /404/);
    assert.match(text(res), /Product not found/);
    await client.close();
  });

  it("supports raw requests restricted to /admin", async () => {
    const client = await connect(TOKEN);
    seen.length = 0;
    const ok: any = await client.callTool({
      name: "medusa_call_operation",
      arguments: { method: "GET", path: "/admin/custom/thing", query: { id: ["a", "b"] } },
    });
    assert.ok(!ok.isError, text(ok));
    assert.equal(seen[0].url, "/admin/custom/thing?id[0]=a&id[1]=b");

    const bad: any = await client.callTool({
      name: "medusa_call_operation",
      arguments: { method: "GET", path: "/store/products" },
    });
    assert.equal(bad.isError, true);
    await client.close();
  });

  it("uploads files as multipart", async () => {
    const client = await connect(TOKEN);
    seen.length = 0;
    const res: any = await client.callTool({
      name: "medusa_upload_files",
      arguments: { files: [{ filename: "a.txt", content_base64: Buffer.from("hello").toString("base64") }] },
    });
    assert.ok(!res.isError, text(res));
    assert.match(seen[0].contentType ?? "", /multipart\/form-data/);
    assert.match(seen[0].body, /hello/);
    await client.close();
  });
});

describe("filters", () => {
  const spec = loadSpec({});
  it("read-only mode keeps only GET operations", () => {
    const catalog = new Catalog(spec, { readOnly: true, includeTags: [], excludeTags: [], excludeOperations: [] });
    assert.ok(catalog.operations.length > 0);
    assert.ok(catalog.operations.every((o) => o.method === "GET"));
  });

  it("include/exclude tags", () => {
    const catalog = new Catalog(spec, {
      readOnly: false,
      includeTags: ["products", "Orders"],
      excludeTags: [],
      excludeOperations: ["DeleteProductsId"],
    });
    assert.deepEqual([...new Set(catalog.operations.map((o) => o.tag))].sort(), ["Orders", "Products"]);
    assert.equal(catalog.get("DeleteProductsId"), undefined);
  });

  it("full mode produces valid tool names", () => {
    const config = loadConfig({
      MEDUSA_BASE_URL: "http://localhost:9000",
      MEDUSA_API_KEY: "sk",
      MCP_TRANSPORT: "stdio",
      MCP_TOOL_MODE: "full",
    });
    const catalog = new Catalog(spec, config);
    const tools = buildTools({ config, catalog, client: new MedusaClient(config) });
    assert.ok(tools.length > 300);
    for (const t of tools) assert.match(t.tool.name, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(new Set(tools.map((t) => t.tool.name)).size, tools.length);
  });
});

describe("query serialization", () => {
  it("serializes nested objects and arrays", () => {
    assert.equal(
      toQueryString({ q: "a b", id: ["x"], created_at: { $gt: "2024" }, skip: undefined }),
      "q=a%20b&id[0]=x&created_at[$gt]=2024",
    );
  });
});
