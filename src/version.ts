import { readFileSync } from "node:fs";

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Version from package.json; GIT_SHA is baked into Docker images by CI. */
export const VERSION = packageVersion();
export const COMMIT = (process.env.GIT_SHA ?? "").slice(0, 7) || undefined;
export const VERSION_LABEL = COMMIT ? `${VERSION} (${COMMIT})` : VERSION;
