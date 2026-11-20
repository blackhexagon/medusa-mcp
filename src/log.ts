// All logs go to stderr so they never corrupt the stdio transport.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL?.toLowerCase() as Level) ?? "info"] ?? LEVELS.info;

function write(level: Level, msg: string, extra?: unknown) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  process.stderr.write(extra === undefined ? `${line}\n` : `${line} ${extra instanceof Error ? extra.stack : JSON.stringify(extra)}\n`);
}

export const log = {
  debug: (msg: string, extra?: unknown) => write("debug", msg, extra),
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
};
