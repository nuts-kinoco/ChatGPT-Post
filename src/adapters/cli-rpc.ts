/** Encrypted/authenticated, bounded one-request Unix-socket protocol. The PSK must be provisioned
 * outside task data, readable only by the controller and broker, never by job children. */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { parseStrictJsonBytes } from "../contracts/task.js";
import type { ArtifactRef, TaskSpec } from "../contracts/task-types.js";
import type {
  ExecutionIdentity,
  ExecutorObservation,
  TaskExecutor,
} from "../state/task-executor.js";
import type { RunIntent } from "../state/task-store.js";

const MAX_FRAME = 8 * 1024 * 1024;
const AAD = Buffer.from("bridge-cli-rpc/1");
type Method = "check" | "start" | "status" | "cancel" | "collect" | "artifact";
interface Request {
  protocol: "bridge-cli-rpc/1";
  id: string;
  at: number;
  method: Method;
  args: unknown;
}
interface Response {
  protocol: "bridge-cli-rpc/1";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}
export interface CliBrokerSocketOptions {
  socketPath: string;
  key: Uint8Array;
  timeoutMs?: number;
}
function keyCopy(key: Uint8Array): Buffer {
  if (key.length !== 32) throw new Error("cli_broker_key_must_be_256_bits");
  return Buffer.from(key);
}
export function encodeCliRpcFrame(
  value: unknown,
  key: Buffer,
  direction: "request" | "response",
): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.concat([AAD, Buffer.from(direction)]));
  const body = Buffer.concat([
    nonce,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  if (body.length > MAX_FRAME) throw new Error("cli_rpc_frame_limit");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}
export function decodeCliRpcBody(
  body: Buffer,
  key: Buffer,
  direction: "request" | "response",
): unknown {
  if (body.length < 29) throw new Error("cli_rpc_invalid_envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, body.subarray(0, 12));
  decipher.setAAD(Buffer.concat([AAD, Buffer.from(direction)]));
  decipher.setAuthTag(body.subarray(-16));
  return parseStrictJsonBytes(
    Buffer.concat([decipher.update(body.subarray(12, -16)), decipher.final()]),
  );
}
function receive(socket: Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let done = false;
    const finish = (error?: Error, body?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      if (error) reject(error);
      else resolve(body as Buffer);
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error("cli_rpc_connection_closed_unknown"));
    const onData = (data: Buffer) => {
      if (buffer.length + data.length > MAX_FRAME + 4) {
        finish(new Error("cli_rpc_frame_limit"));
        return;
      }
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length < 29 || length > MAX_FRAME || buffer.length > length + 4) {
        finish(new Error("cli_rpc_frame_invalid"));
        return;
      }
      if (buffer.length === length + 4) finish(undefined, buffer.subarray(4));
    };
    const timer = setTimeout(() => finish(new Error("cli_rpc_timeout_unknown")), timeoutMs);
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
  });
}
async function privateSocketParent(path: string): Promise<void> {
  if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path) > 100)
    throw new Error("cli_rpc_socket_path_invalid");
  const parent = dirname(path);
  const stat = await lstat(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.() ||
    (await realpath(parent)) !== parent
  )
    throw new Error("cli_rpc_socket_directory_not_private");
}
export class CliBrokerExecutor implements TaskExecutor {
  readonly synthetic = false;
  private readonly key: Buffer;
  private readonly socketPath: string;
  private readonly timeout: number;
  constructor(
    readonly executorId: string,
    options: CliBrokerSocketOptions,
  ) {
    this.key = keyCopy(options.key);
    this.socketPath = options.socketPath;
    this.timeout = options.timeoutMs ?? 15000;
  }
  private async call(method: Method, args: unknown): Promise<unknown> {
    if (process.platform === "win32")
      throw new Error("sandbox_capability_unavailable: authenticated-windows-pipe-not-installed");
    await privateSocketParent(this.socketPath);
    const stat = await lstat(this.socketPath);
    if (!stat.isSocket() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
      throw new Error("cli_rpc_socket_permissions");
    const id = randomUUID();
    const request: Request = { protocol: "bridge-cli-rpc/1", id, at: Date.now(), method, args };
    const frame = encodeCliRpcFrame(request, this.key, "request");
    const socket = createConnection(this.socketPath);
    socket.on("error", () => {
      /* receive owns errors, including post-frame socket errors */
    });
    try {
      const pending = receive(socket, this.timeout);
      socket.write(frame);
      const response = decodeCliRpcBody(await pending, this.key, "response") as Response;
      if (
        !response ||
        response.protocol !== request.protocol ||
        response.id !== id ||
        typeof response.ok !== "boolean"
      )
        throw new Error("cli_rpc_response_identity_mismatch");
      if (!response.ok) throw new Error(response.error ?? "cli_rpc_denied");
      return response.value;
    } finally {
      socket.destroy();
    }
  }
  async checkCapabilities(task: TaskSpec): Promise<void> {
    await this.call("check", { task, executorId: this.executorId });
  }
  async start(
    task: TaskSpec,
    taskBytes: Uint8Array,
    identity: ExecutionIdentity,
    intent: RunIntent,
  ): Promise<ExecutorObservation> {
    return (await this.call("start", {
      task,
      taskBytes: Buffer.from(taskBytes).toString("base64"),
      identity,
      intent,
      executorId: this.executorId,
    })) as ExecutorObservation;
  }
  async status(identity: ExecutionIdentity): Promise<ExecutorObservation> {
    return (await this.call("status", {
      identity,
      executorId: this.executorId,
    })) as ExecutorObservation;
  }
  async cancel(
    identity: ExecutionIdentity,
    reason: "user" | "timeout",
    graceSeconds: number,
  ): Promise<ExecutorObservation> {
    return (await this.call("cancel", {
      identity,
      reason,
      graceSeconds,
      executorId: this.executorId,
    })) as ExecutorObservation;
  }
  async collect(identity: ExecutionIdentity): Promise<ExecutorObservation> {
    return (await this.call("collect", {
      identity,
      executorId: this.executorId,
    })) as ExecutorObservation;
  }
  async readArtifact(ref: ArtifactRef): Promise<Uint8Array> {
    const value = await this.call("artifact", { ref, executorId: this.executorId });
    if (
      !value ||
      typeof value !== "object" ||
      !("base64" in value) ||
      typeof value.base64 !== "string"
    )
      throw new Error("cli_rpc_artifact_invalid");
    return Buffer.from(value.base64, "base64");
  }
}
/** Bind explicitly; importing this module never starts a service or installs authentication. */
export async function listenCliBroker(
  service: TaskExecutor,
  options: CliBrokerSocketOptions,
): Promise<{ server: Server; close: () => Promise<void> }> {
  if (process.platform === "win32")
    throw new Error("sandbox_capability_unavailable: authenticated-windows-pipe-not-installed");
  await privateSocketParent(options.socketPath);
  const key = keyCopy(options.key);
  // Never unlink a possibly live prior service socket. The administrator reconciles a stale socket.
  try {
    await lstat(options.socketPath);
    throw new Error("cli_rpc_socket_already_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sockets = new Set<Socket>();
  const seen = new Map<string, number>();
  const server = createServer((socket) => {
    if (sockets.size >= 64) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
      /* each request owns its own failure */
    });
    void (async () => {
      try {
        const raw = decodeCliRpcBody(
          await receive(socket, options.timeoutMs ?? 15000),
          key,
          "request",
        ) as Request;
        if (
          raw?.protocol !== "bridge-cli-rpc/1" ||
          !/^[a-f0-9-]{36}$/.test(raw.id) ||
          !Number.isSafeInteger(raw.at) ||
          Math.abs(Date.now() - raw.at) > 30000 ||
          !raw.args ||
          typeof raw.args !== "object"
        )
          throw new Error("cli_rpc_request_invalid");
        const now = Date.now();
        for (const [id, at] of seen) if (now - at > 60000) seen.delete(id);
        if (seen.has(raw.id) || seen.size >= 10000) throw new Error("cli_rpc_replay_or_capacity");
        seen.set(raw.id, now);
        const args = raw.args as Record<string, unknown>;
        if (args.executorId !== service.executorId) throw new Error("cli_rpc_executor_mismatch");
        const result: Response = { protocol: raw.protocol, id: raw.id, ok: true };
        try {
          const identity = args.identity as ExecutionIdentity;
          switch (raw.method) {
            case "check":
              await service.checkCapabilities(args.task as TaskSpec);
              result.value = null;
              break;
            case "start": {
              if (
                typeof args.taskBytes !== "string" ||
                args.taskBytes.length > 1400000 ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                  args.taskBytes,
                )
              )
                throw new Error("cli_rpc_task_bytes_invalid");
              result.value = await service.start(
                args.task as TaskSpec,
                Buffer.from(args.taskBytes, "base64"),
                identity,
                args.intent as RunIntent,
              );
              break;
            }
            case "status":
              result.value = await service.status(identity);
              break;
            case "cancel":
              result.value = await service.cancel(
                identity,
                args.reason as "user" | "timeout",
                args.graceSeconds as number,
              );
              break;
            case "collect":
              result.value = await service.collect(identity);
              break;
            case "artifact":
              result.value = {
                base64: Buffer.from(await service.readArtifact(args.ref as ArtifactRef)).toString(
                  "base64",
                ),
              };
              break;
            default:
              throw new Error("cli_rpc_method_denied");
          }
        } catch (error) {
          result.ok = false;
          result.error =
            error instanceof Error && /^[a-zA-Z0-9_:, /.-]{1,256}$/.test(error.message)
              ? error.message
              : "cli_rpc_operation_denied";
        }
        socket.end(encodeCliRpcFrame(result, key, "response"));
      } catch {
        socket.destroy();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(options.socketPath, 0o600);
  return {
    server,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      try {
        await unlink(options.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      key.fill(0);
    },
  };
}
