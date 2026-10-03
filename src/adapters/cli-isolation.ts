/** Production direct-argv driver for an independently installed enforcing supervisor.
 * No CLI is ever spawned directly. No built-in platform confinement is claimed here. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
import type { ArtifactRef } from "../contracts/task-types.js";
import type { ExecutionIdentity, ExecutorObservation } from "../state/task-executor.js";
import type { CliLaunchPlan } from "./cli-launch.js";

export const CLI_ISOLATION_REQUIREMENTS = [
  "atomic-executable-hash-at-exec",
  "exact-argv-cwd-env",
  "per-operation-path-scope",
  "command-allowlist-and-max-runs",
  "task-network-deny",
  "provider-control-plane-separated",
  "descendant-containment",
  "durable-deadline",
  "durable-cancel-tombstones",
  "durable-run-dedupe",
  "resource-fencing",
  "actual-base-commit",
  "protected-evidence-store",
  "actual-agent-model",
  "complete-diff-and-log-evidence",
  "no-config-hooks-or-plugin-escape",
] as const;
export interface CliIsolationCapabilities {
  protocol: "bridge-cli-isolation/1";
  platform: "linux" | "win32" | "darwin";
  implementation: string;
  enforced: string[];
  executableSha256: string;
  actualBaseCommit: string;
  actualVersion: string;
}
export type CliCapabilityRequest = Pick<
  CliLaunchPlan,
  "task" | "executable" | "executableSha256" | "version"
>;
export interface CliIsolationRuntime {
  check(plan: CliCapabilityRequest): Promise<CliIsolationCapabilities>;
  start(plan: CliLaunchPlan): Promise<ExecutorObservation>;
  status(identity: ExecutionIdentity): Promise<ExecutorObservation>;
  cancel(
    identity: ExecutionIdentity,
    reason: "user" | "timeout",
    graceSeconds: number,
  ): Promise<ExecutorObservation>;
  collect(identity: ExecutionIdentity): Promise<ExecutorObservation>;
  readArtifact(ref: ArtifactRef): Promise<Uint8Array>;
}
export function verifyIsolationCapabilities(
  c: CliIsolationCapabilities,
  plan: CliCapabilityRequest,
): void {
  if (
    c?.protocol !== "bridge-cli-isolation/1" ||
    !c.implementation ||
    !["linux", "win32", "darwin"].includes(c.platform) ||
    !Array.isArray(c.enforced)
  )
    throw new Error("sandbox_capability_unavailable: invalid supervisor response");
  const absent = CLI_ISOLATION_REQUIREMENTS.filter(
    (requirement) => !c.enforced.includes(requirement),
  );
  if (absent.length) throw new Error(`sandbox_capability_unavailable: ${absent.join(",")}`);
  if (c.executableSha256 !== plan.executableSha256 || c.actualVersion !== plan.version)
    throw new Error("cli_binary_or_version_mismatch");
  if (c.actualBaseCommit !== plan.task.base_commit) throw new Error("base_commit_mismatch");
}
export interface InstalledCliIsolationOptions {
  executable: string;
  sha256: string;
  /** Administratively installed owner, normally root. Not accepted from a task. */
  ownerUid: number;
  rpcTimeoutMs?: number;
  maxResponseBytes?: number;
}
export class InstalledCliIsolationRuntime implements CliIsolationRuntime {
  private readonly options: InstalledCliIsolationOptions;
  constructor(options: InstalledCliIsolationOptions) {
    this.options = structuredClone(options);
    if (
      !isAbsolute(options.executable) ||
      !/^[a-f0-9]{64}$/.test(options.sha256) ||
      !Number.isSafeInteger(options.ownerUid) ||
      options.ownerUid < 0
    )
      throw new Error("isolation_installation_invalid");
  }
  private async invoke(operation: string, argument: unknown): Promise<unknown> {
    // Linux fd execution binds the executed ELF to the hash-verified descriptor. Windows needs
    // a native service/Job Object implementation; it is not approximated with taskkill or a PID.
    if (process.platform !== "linux")
      throw new Error(`sandbox_capability_unavailable: installed-fd-launcher/${process.platform}`);
    const o = this.options;
    let parent = dirname(o.executable);
    while (true) {
      const s = await lstat(parent);
      if (
        !s.isDirectory() ||
        s.isSymbolicLink() ||
        (s.mode & 0o022) !== 0 ||
        (s.uid !== 0 && s.uid !== o.ownerUid)
      )
        throw new Error("isolation_installation_permissions");
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    if ((await realpath(o.executable)) !== o.executable)
      throw new Error("isolation_binary_symlink");
    const file = await open(o.executable, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await file.stat();
      if (
        !s.isFile() ||
        s.nlink !== 1 ||
        s.uid !== o.ownerUid ||
        (s.mode & 0o022) !== 0 ||
        !(s.mode & 0o111) ||
        s.size > 256 * 1024 * 1024
      )
        throw new Error("isolation_binary_permissions");
      const bytes = await file.readFile();
      if (
        !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        sha256Bytes(bytes) !== o.sha256
      )
        throw new Error("isolation_binary_hash_mismatch");
      const response = await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(
          "/proc/self/fd/3",
          ["rpc", "--protocol", "bridge-cli-isolation/1", operation],
          {
            cwd: "/",
            env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
            shell: false,
            detached: true,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe", file.fd],
          },
        );
        const parts: Buffer[] = [];
        let total = 0;
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) {
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                /* exited */
              }
            }
            reject(error);
          } else resolve(Buffer.concat(parts));
        };
        const timer = setTimeout(
          () => finish(new Error("isolation_rpc_timeout_unknown")),
          o.rpcTimeoutMs ?? 10000,
        );
        child.on("error", (error) => finish(error));
        child.stdout?.on("data", (data: Buffer) => {
          total += data.length;
          if (total > (o.maxResponseBytes ?? 8 * 1024 * 1024))
            finish(new Error("isolation_rpc_response_limit"));
          else parts.push(data);
        });
        child.stderr?.on("data", (data: Buffer) => {
          total += data.length; // never log potentially sensitive supervisor stderr
          if (total > (o.maxResponseBytes ?? 8 * 1024 * 1024))
            finish(new Error("isolation_rpc_response_limit"));
        });
        child.on("close", (code) =>
          finish(code === 0 ? undefined : new Error("isolation_rpc_failed_unknown")),
        );
        child.stdin?.on("error", (error) => finish(error));
        child.stdin?.end(JSON.stringify(argument));
      });
      return parseStrictJsonBytes(response);
    } finally {
      await file.close();
    }
  }
  async check(plan: CliCapabilityRequest): Promise<CliIsolationCapabilities> {
    const c = (await this.invoke("check", plan)) as CliIsolationCapabilities;
    verifyIsolationCapabilities(c, plan);
    return c;
  }
  async start(plan: CliLaunchPlan): Promise<ExecutorObservation> {
    return (await this.invoke("start", plan)) as ExecutorObservation;
  }
  async status(identity: ExecutionIdentity): Promise<ExecutorObservation> {
    return (await this.invoke("status", { identity })) as ExecutorObservation;
  }
  async cancel(
    identity: ExecutionIdentity,
    reason: "user" | "timeout",
    graceSeconds: number,
  ): Promise<ExecutorObservation> {
    return (await this.invoke("cancel", { identity, reason, graceSeconds })) as ExecutorObservation;
  }
  async collect(identity: ExecutionIdentity): Promise<ExecutorObservation> {
    return (await this.invoke("collect", { identity })) as ExecutorObservation;
  }
  async readArtifact(ref: ArtifactRef): Promise<Uint8Array> {
    const value = await this.invoke("artifact", { ref });
    if (
      !value ||
      typeof value !== "object" ||
      !("base64" in value) ||
      typeof value.base64 !== "string"
    )
      throw new Error("isolation_artifact_invalid");
    const data = Buffer.from(value.base64, "base64");
    if (data.length !== ref.size_bytes || sha256Bytes(data) !== ref.sha256)
      throw new Error("isolation_artifact_hash_mismatch");
    return data;
  }
}
