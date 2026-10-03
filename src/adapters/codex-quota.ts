/** Public app-server JSONL management protocol, deliberately limited to initialize + quota read.
 * Never starts threads/turns, requests authentication, refreshes tokens or consumes reset credits.
 * https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt
 */
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
import {
  type AccountQuotaPort,
  type AccountRateLimits,
  type RateLimitWindow,
  validateAccountRateLimits,
} from "../state/task-quota.js";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export class CodexQuotaClient implements AccountQuotaPort {
  readonly providerId = "codex" as const;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private initialized: Promise<void> | null = null;
  private ended = false;
  private readonly dataListener = (chunk: Buffer) => this.consume(chunk);
  private readonly closeListener = () => this.fail(new Error("quota_channel_closed"));
  constructor(
    readonly input: Writable,
    readonly output: Readable,
    readonly cliVersion: string,
    readonly protocolVersion: string,
    readonly timeoutMs = 5000,
  ) {
    if (!cliVersion || !protocolVersion || timeoutMs < 1 || timeoutMs > 60000)
      throw new Error("quota_config_invalid");
    output.on("data", this.dataListener);
    output.on("end", this.closeListener);
    output.on("error", this.closeListener);
    input.on("error", this.closeListener);
  }
  private fail(error: Error) {
    this.ended = true;
    this.buffer = Buffer.alloc(0);
    this.output.off("data", this.dataListener);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  close() {
    this.fail(new Error("quota_channel_closed"));
    this.output.off("data", this.dataListener);
    this.output.off("end", this.closeListener);
    this.output.off("error", this.closeListener);
    this.input.off("error", this.closeListener);
  }
  private consume(chunk: Buffer) {
    if (this.ended) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 1024 * 1024) {
      this.fail(new Error("quota_response_too_large"));
      return;
    }
    while (this.buffer.includes(10)) {
      const index = this.buffer.indexOf(10);
      const line = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      try {
        const value = parseStrictJsonBytes(line) as Record<string, unknown>;
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("quota_protocol_invalid");
        // Server requests (including refresh/attestation) are denied; credentials never enter here.
        if (value.method && value.id !== undefined) {
          this.input.write(
            `${JSON.stringify({ id: value.id, error: { code: -32601, message: "Host management client does not authorize this method" } })}\n`,
          );
          continue;
        }
        if (typeof value.id !== "number") continue; // notification, never a reply
        const pending = this.pending.get(value.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(value.id);
        if (value.error) pending.reject(new Error("quota_rpc_failed"));
        else if (Object.hasOwn(value, "result")) pending.resolve(value.result);
        else pending.reject(new Error("quota_protocol_invalid"));
      } catch {
        this.fail(new Error("quota_protocol_invalid"));
        return;
      }
    }
  }
  private rpc(
    method: "initialize" | "account/rateLimits/read",
    params?: unknown,
  ): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error("quota_channel_closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("quota_rpc_timeout"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(
        `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`,
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(new Error("quota_write_failed"));
          }
        },
      );
    });
  }
  async readRateLimits(): Promise<AccountRateLimits> {
    this.initialized ??= this.rpc("initialize", {
      clientInfo: { name: "chatgpt_post_quota", title: "Bridge quota observer", version: "1.0.0" },
    }).then(() => {
      this.input.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    });
    await this.initialized;
    const raw = await this.rpc("account/rateLimits/read");
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("quota_response_invalid");
    const response = raw as Record<string, unknown>;
    let values: unknown[];
    if (
      response.rateLimitsByLimitId &&
      typeof response.rateLimitsByLimitId === "object" &&
      !Array.isArray(response.rateLimitsByLimitId)
    ) {
      values = Object.entries(response.rateLimitsByLimitId).map(([key, value]) => {
        if (
          !value ||
          typeof value !== "object" ||
          (value as Record<string, unknown>).limitId !== key
        )
          throw new Error("quota_limit_id_mismatch");
        return value;
      });
    } else values = [response.rateLimits];
    const observation: AccountRateLimits = {
      source: "account/rateLimits/read",
      cliVersion: this.cliVersion,
      protocolVersion: this.protocolVersion,
      limits: values.map((value) => {
        if (!value || typeof value !== "object") throw new Error("quota_response_invalid");
        const row = value as Record<string, unknown>;
        if (
          typeof row.limitId !== "string" ||
          !Object.hasOwn(row, "primary") ||
          !Object.hasOwn(row, "secondary")
        )
          throw new Error("quota_response_invalid");
        for (const window of [row.primary, row.secondary])
          if (window !== null && (typeof window !== "object" || Array.isArray(window)))
            throw new Error("quota_response_invalid");
        return {
          limitId: row.limitId,
          primary: row.primary as RateLimitWindow | null,
          secondary: row.secondary as RateLimitWindow | null,
        };
      }),
    };
    validateAccountRateLimits(observation);
    return observation;
  }
}
/** Optional explicitly-configured host launcher. No shell/PATH lookup or inherited credentials.
 * Deploying/starting this with account access is a separate authorized host operation. */
export async function launchCodexQuota(config: {
  executable: string;
  sha256: string;
  cwd: string;
  environment: Record<string, string>;
  cliVersion: string;
  protocolVersion: string;
}): Promise<{ client: CodexQuotaClient; close(): void }> {
  if (
    !isAbsolute(config.executable) ||
    !isAbsolute(config.cwd) ||
    !/^[0-9a-f]{64}$/.test(config.sha256) ||
    /\.(cmd|bat|ps1)$/i.test(config.executable)
  )
    throw new Error("quota_executable_denied");
  const executable = await realpath(config.executable);
  if (sha256Bytes(await readFile(executable)) !== config.sha256)
    throw new Error("quota_executable_hash_mismatch");
  const cwd = await realpath(config.cwd);
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
    cwd,
    env: { ...config.environment },
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const client = new CodexQuotaClient(
    child.stdin,
    child.stdout,
    config.cliVersion,
    config.protocolVersion,
  );
  child.on("error", () => client.close());
  child.on("exit", () => client.close());
  return {
    client,
    close() {
      client.close();
      child.stdin.end();
      child.kill();
    },
  };
}
