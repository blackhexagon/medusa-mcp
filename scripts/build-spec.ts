/**
 * Converts the (huge) Medusa OpenAPI YAML into a compact JSON file that the
 * server loads at startup.
 *
 *   tsx scripts/build-spec.ts openapi.yaml generated/spec.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildCompactSpec } from "../src/spec/build.js";

const [input = "openapi.yaml", output = "generated/spec.json"] = process.argv.slice(2);

const spec = buildCompactSpec(readFileSync(input, "utf8"));
mkdirSync(dirname(output), { recursive: true });
const json = JSON.stringify(spec);
writeFileSync(output, json);

const tags = new Set(spec.operations.map((o) => o.tag));
console.log(
  `${spec.title} ${spec.version}: ${spec.operations.length} operations, ${tags.size} tags, ` +
    `${Object.keys(spec.schemas).length} schemas -> ${output} (${(json.length / 1024).toFixed(0)} KiB)`,
);
