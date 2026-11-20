#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { log } from "./log.js";
import { MedusaClient } from "./medusa/client.js";
import { createMcpServer } from "./server.js";
import { Catalog, loadSpec } from "./spec/catalog.js";
import { buildTools } from "./tools/index.js";

async function main() {
  const config = loadConfig();
  const catalog = new Catalog(loadSpec(config), config);
  const client = new MedusaClient(config);
  const tools = buildTools({ config, catalog, client });

  log.info(
    `Medusa Admin API ${catalog.spec.version}: ${catalog.operations.length} operations enabled, ` +
      `${tools.length} tools (mode=${config.toolMode}${config.readOnly ? ", read-only" : ""}) -> ${config.medusaBaseUrl}`,
  );
  if (config.toolMode === "full" && tools.length > 100) {
    log.warn(`${tools.length} tools exposed. Consider MEDUSA_INCLUDE_TAGS or MCP_TOOL_MODE=dynamic to save LLM context.`);
  }

  const create = () => createMcpServer(config, tools, catalog.operations.length);

  if (config.transport === "stdio") {
    await create().connect(new StdioServerTransport());
    log.info("medusa-mcp running on stdio");
  } else {
    startHttpServer(config, create);
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
