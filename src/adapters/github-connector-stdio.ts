/** One-shot host mediation over an explicit stream pair, never a credential or model-output channel. */
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { parseStrictProviderJsonBytes } from "../contracts/task.js";
import type { GitHubConnectorHost, GitHubConnectorOperation } from "./github-connector-store.js";
export class StdioGitHubConnectorHost implements GitHubConnectorHost {
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; cleanup: () => void }
  >();
  private buffer: Buffer;
  private used = 0;
  private ended = false;
  private readonly onData: (b: Buffer) => void;
  private readonly onEnd: () => void;
  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 8 * 1024 * 1024)
      throw new Error("connector_stdio_bounds");
    this.buffer = Buffer.alloc(maxBytes);
    this.onData = (chunk) => {
      try {
        if (this.ended) return;
        if (!Buffer.isBuffer(chunk)) throw new Error("connector_stdio_response_invalid");
        for (const byte of chunk) {
          if (this.used >= this.maxBytes) throw new Error("connector_stdio_response_limit");
          this.buffer[this.used++] = byte;
          if (byte !== 10) continue;
          const v = parseStrictProviderJsonBytes(this.buffer.subarray(0, this.used - 1)) as {
            schema?: unknown;
            id?: unknown;
            result?: unknown;
          };
          this.used = 0;
          if (
            !v ||
            typeof v !== "object" ||
            Array.isArray(v) ||
            Object.keys(v).sort().join(",") !== "id,result,schema" ||
            v.schema !== "bridge-github-response-1" ||
            typeof v.id !== "string" ||
            v.id.length !== 36 ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.id)
          )
            throw new Error("connector_stdio_response_invalid");
          const p = this.pending.get(v.id);
          if (p) {
            this.pending.delete(v.id);
            p.cleanup();
            p.resolve(v.result);
          }
        }
      } catch {
        this.close("connector_stdio_response_invalid");
      }
    };
    this.onEnd = () => this.close("connector_stdio_closed");
    input.on("data", this.onData);
    input.on("end", this.onEnd);
    input.on("error", this.onEnd);
    output.on("error", this.onEnd);
  }
  call(operation: GitHubConnectorOperation, signal: AbortSignal): Promise<unknown> {
    if (this.ended || signal.aborted) return Promise.reject(new Error("connector_stdio_closed"));
    if (this.pending.size >= 16) return Promise.reject(new Error("connector_stdio_capacity"));
    const id = randomUUID(),
      request = Buffer.from(
        `${JSON.stringify({ schema: "bridge-github-operation-1", id, operation: structuredClone(operation) })}\n`,
      );
    if (request.length > this.maxBytes)
      return Promise.reject(new Error("connector_stdio_request_limit"));
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        signal.removeEventListener("abort", abort);
        reject(new Error("github_timeout"));
      };
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", abort),
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      this.output.write(request, (error) => {
        if (error) this.close("connector_stdio_write_failed");
      });
    });
  }
  close(code = "connector_stdio_closed"): void {
    if (this.ended) return;
    this.ended = true;
    this.buffer.fill(0);
    this.used = 0;
    this.input.pause();
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("error", this.onEnd);
    this.output.off("error", this.onEnd);
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(new Error(code));
    }
    this.pending.clear();
  }
}
