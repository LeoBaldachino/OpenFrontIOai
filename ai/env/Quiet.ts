/**
 * Console discipline for env workers. Import it FIRST in a worker entry
 * (before anything from src/core), so engine chatter such as
 * "[GameImpl] Constructor total" or SpawnExecution warnings neither floods
 * the logs nor costs formatting time in the hot loop:
 *
 *   import "../env/Quiet";            // first line of worker-main.ts
 *
 * On import it replaces console.debug/log/info/warn with a level filter that
 * writes to stderr (stdout stays clean). The level comes from
 * OFRL_LOG_LEVEL = silent | error | warn | info | debug (default "error"):
 *   error / silent: debug, log, info and warn are dropped
 *   warn:           warn printed
 *   info:           warn, info and log printed
 *   debug:          everything printed
 * console.error is never touched. Suppressed calls are counted
 * (`suppressedWarnings()`, `suppressedCounts()`), so the worker can report
 * how many engine warnings it swallowed in its episode summaries.
 */
import { format } from "util";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
type Method = "debug" | "log" | "info" | "warn";

const RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};
/** Level at which each console method starts printing. */
const NEEDS: Record<Method, number> = { warn: 2, info: 3, log: 3, debug: 4 };
const METHODS: readonly Method[] = ["debug", "log", "info", "warn"];

export function parseLogLevel(
  v: string | undefined,
  fallback: LogLevel = "error",
): LogLevel {
  const s = (v ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(RANK, s)
    ? (s as LogLevel)
    : fallback;
}

interface QuietState {
  level: LogLevel;
  write: (line: string) => void;
  originals: Partial<Record<Method, (...args: unknown[]) => void>>;
  suppressed: Record<Method, number>;
  installed: boolean;
}

const state: QuietState = {
  level: "error",
  write: (line) => {
    if (typeof process !== "undefined" && process.stderr) {
      process.stderr.write(line);
    }
  },
  originals: {},
  suppressed: { debug: 0, log: 0, info: 0, warn: 0 },
  installed: false,
};

export interface QuietOptions {
  level?: LogLevel;
  /** Output sink for printed lines (default: process.stderr). */
  write?: (line: string) => void;
}

/** Installs (or reconfigures) the filter. Idempotent. */
export function installQuiet(opts: QuietOptions = {}): void {
  if (opts.level !== undefined) state.level = opts.level;
  if (opts.write !== undefined) state.write = opts.write;
  if (state.installed) return;
  for (const m of METHODS) {
    state.originals[m] = console[m] as (...args: unknown[]) => void;
    console[m] = (...args: unknown[]) => {
      if (RANK[state.level] >= NEEDS[m]) {
        state.write(format(...args) + "\n");
      } else {
        state.suppressed[m]++;
      }
    };
  }
  state.installed = true;
}

/** Puts the original console methods back (tests). */
export function restoreConsole(): void {
  if (!state.installed) return;
  for (const m of METHODS) {
    const orig = state.originals[m];
    if (orig !== undefined) console[m] = orig;
  }
  state.originals = {};
  state.installed = false;
}

export function setLogLevel(level: LogLevel): void {
  state.level = level;
}

export function getLogLevel(): LogLevel {
  return state.level;
}

/** console.warn calls swallowed since start (or the last reset). */
export function suppressedWarnings(): number {
  return state.suppressed.warn;
}

/** Swallowed calls per console method. */
export function suppressedCounts(): Record<Method, number> {
  return { ...state.suppressed };
}

export function resetSuppressedCounts(): void {
  for (const m of METHODS) state.suppressed[m] = 0;
}

installQuiet({
  level: parseLogLevel(
    typeof process !== "undefined" ? process.env.OFRL_LOG_LEVEL : undefined,
  ),
});
