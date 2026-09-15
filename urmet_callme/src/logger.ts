// Tiny leveled logger. Level set once from config (log_level). Tagged, timestamped.
export type Level = "debug" | "info" | "warn" | "error";
const RANK: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
let threshold = RANK.info;

export function setLevel(l?: string): void {
  const k = (l || "").toLowerCase() as Level;
  if (k in RANK) threshold = RANK[k];
}

/** True at `log_level: debug`; the media helpers get their own trace switch from it. */
export function isDebug(): boolean {
  return threshold <= RANK.debug;
}

/** Redact a secret for logs: keep first/last 2 chars. */
export function redact(s?: string): string {
  if (!s) return "(none)";
  return s.length <= 6 ? "***" : `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function emit(level: Level, tag: string, args: unknown[]): void {
  if (RANK[level] < threshold) return;
  const prefix = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${tag}]`;
  const fn =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  fn(prefix, ...args);
}

export interface Log {
  debug: (...a: unknown[]) => void;
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}

export function logger(tag: string): Log {
  return {
    debug: (...a) => emit("debug", tag, a),
    info: (...a) => emit("info", tag, a),
    warn: (...a) => emit("warn", tag, a),
    error: (...a) => emit("error", tag, a),
  };
}
