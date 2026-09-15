import { redact } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  level: LogLevel;
  log: (level: LogLevel, message: string) => void;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

/** stdout = human progress, stderr = diagnostics (FR-005). Everything passes through redact(). */
export function createLogger(level: LogLevel = "info"): Logger {
  return {
    level,
    log: (lvl, message) => {
      if (ORDER[lvl] < ORDER[level]) return;
      const line = `[${new Date().toISOString()}] ${lvl.toUpperCase()} ${redact(message, 2000)}`;
      process.stderr.write(`${line}\n`);
    },
    stdout: (message) => process.stdout.write(`${redact(message, 2000)}\n`),
    stderr: (message) => process.stderr.write(`${redact(message, 2000)}\n`),
  };
}
