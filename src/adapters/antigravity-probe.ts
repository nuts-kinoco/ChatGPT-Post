/** Metadata only. Not a provider inference runtime or OS confinement mechanism. */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { type AntigravityCliCapabilities, inspectAntigravityHelp } from "./antigravity.js";

export type AntigravityMetadataOperation = "version" | "help" | "models";
export type ProbeFailure =
  | "auth_required"
  | "timeout"
  | "output_limit"
  | "process_failed"
  | "malformed_output"
  | "binary_untrusted"
  | "platform_unsupported"
  | "cancelled";
export type AntigravityProbeResult =
  | {
      kind: "completed";
      operation: AntigravityMetadataOperation;
      stdout: string;
      stderr: string;
      observedAt: string;
      binarySha256: string;
    }
  | { kind: "failed"; operation: AntigravityMetadataOperation; reason: ProbeFailure };
export interface MetadataProbeLease<T> {
  result: Promise<T>;
  /** Resolves only after the owned process closes and private probe resources are cleaned up. */
  exited: Promise<void>;
  cancel(): void;
}
export interface AntigravityProbeInstallation {
  executable: string;
  expectedSha256: string;
  ownerUid: number;
}
export interface AntigravityProbeOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}
const ARGV: Record<AntigravityMetadataOperation, readonly string[]> = {
  version: ["--version"],
  help: ["--help"],
  models: ["models"],
};
const AUTH = /authentication required|sign[ -]?in|log[ -]?in|oauth|authorization code/i;
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
/** Registered installation owner and same-user code are trusted. fd binding prevents path swaps,
 * not same-inode owner writes; no atomic hash-at-exec or descendant-termination claim is made. */
export class AntigravityMetadataProbe {
  private readonly installation: AntigravityProbeInstallation;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private active = false;
  constructor(installation: AntigravityProbeInstallation, options: AntigravityProbeOptions = {}) {
    this.installation = structuredClone(installation);
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxOutputBytes = options.maxOutputBytes ?? 65536;
    if (
      !isAbsolute(installation.executable) ||
      installation.executable.includes("\0") ||
      !/^[a-f0-9]{64}$/.test(installation.expectedSha256) ||
      !Number.isSafeInteger(installation.ownerUid) ||
      installation.ownerUid < 0 ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 10000 ||
      !Number.isSafeInteger(this.maxOutputBytes) ||
      this.maxOutputBytes < 1 ||
      this.maxOutputBytes > 262144
    )
      throw new Error("antigravity_probe_configuration_invalid");
  }
  start(operation: AntigravityMetadataOperation): MetadataProbeLease<AntigravityProbeResult> {
    if (!Object.hasOwn(ARGV, operation)) throw new Error("antigravity_probe_operation_invalid");
    if (this.active) throw new Error("antigravity_probe_in_flight");
    this.active = true;
    let resolveResult!: (value: AntigravityProbeResult) => void;
    let resolveExit!: () => void;
    const result = new Promise<AntigravityProbeResult>((resolve) => {
      resolveResult = resolve;
    });
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    let settled = false;
    let stopped = false;
    let child: ChildProcess | undefined;
    const complete = (value: AntigravityProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(value);
    };
    const stop = (reason: ProbeFailure) => {
      stopped = true;
      complete({ kind: "failed", operation, reason });
      try {
        child?.kill("SIGKILL");
      } catch {
        /* Ownership stays held until close. */
      }
    };
    const timer = setTimeout(() => stop("timeout"), this.timeoutMs);
    const work = async () => {
      let file: Awaited<ReturnType<typeof open>> | undefined;
      let home: string | undefined;
      try {
        if (process.platform !== "linux") {
          stop("platform_unsupported");
          return;
        }
        const install = this.installation;
        if ((await realpath(install.executable)) !== install.executable)
          throw new Error("untrusted");
        let parent = dirname(install.executable);
        while (true) {
          const directory = await lstat(parent);
          if (
            !directory.isDirectory() ||
            directory.isSymbolicLink() ||
            (directory.mode & 0o022) !== 0 ||
            (directory.uid !== 0 && directory.uid !== install.ownerUid)
          )
            throw new Error("untrusted");
          const next = dirname(parent);
          if (next === parent) break;
          parent = next;
        }
        file = await open(install.executable, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await file.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.uid !== install.ownerUid ||
          (before.mode & 0o022) !== 0 ||
          !(before.mode & 0o111) ||
          before.size > MAX_BINARY_BYTES ||
          before.size < 4
        )
          throw new Error("untrusted");
        const header = Buffer.alloc(4);
        await file.read(header, 0, 4, 0);
        if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error("untrusted");
        const hash = createHash("sha256");
        const chunk = Buffer.alloc(1024 * 1024);
        let position = 0;
        while (position < before.size) {
          if (stopped) return;
          const read = await file.read(
            chunk,
            0,
            Math.min(chunk.length, before.size - position),
            position,
          );
          if (!read.bytesRead) throw new Error("untrusted");
          hash.update(chunk.subarray(0, read.bytesRead));
          position += read.bytesRead;
        }
        const after = await file.stat();
        if (
          hash.digest("hex") !== install.expectedSha256 ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error("untrusted");
        if (stopped) return;
        home = await mkdtemp(join(tmpdir(), "bridge-agy-metadata-"));
        if (stopped) return;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytes = 0;
        await new Promise<void>((closed) => {
          child = spawn("/proc/self/fd/3", [...ARGV[operation]], {
            argv0: "agy",
            cwd: home,
            env: { HOME: home, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe", file?.fd ?? "ignore"],
          });
          const data = (target: Buffer[], value: Buffer) => {
            if (settled) return;
            bytes += value.length;
            if (bytes > this.maxOutputBytes) {
              stop("output_limit");
              return;
            }
            target.push(Buffer.from(value));
            // Metadata commands must never continue a login flow. Raw auth diagnostics are withheld.
            if (AUTH.test(Buffer.concat(target).toString("utf8"))) stop("auth_required");
          };
          child.stdout?.on("data", (value: Buffer) => data(stdout, value));
          child.stderr?.on("data", (value: Buffer) => data(stderr, value));
          child.on("error", () =>
            complete({ kind: "failed", operation, reason: "process_failed" }),
          );
          child.on("close", (code) => {
            if (!settled) {
              if (code !== 0) complete({ kind: "failed", operation, reason: "process_failed" });
              else {
                try {
                  const decoder = new TextDecoder("utf8", { fatal: true, ignoreBOM: true });
                  const out = decoder.decode(Buffer.concat(stdout));
                  const err = decoder.decode(Buffer.concat(stderr));
                  if (out.includes("\0") || err.includes("\0")) throw new Error("invalid");
                  complete({
                    kind: "completed",
                    operation,
                    stdout: out,
                    stderr: err,
                    observedAt: new Date().toISOString(),
                    binarySha256: install.expectedSha256,
                  });
                } catch {
                  complete({ kind: "failed", operation, reason: "malformed_output" });
                }
              }
            }
            closed();
          });
          if (stopped) {
            try {
              child.kill("SIGKILL");
            } catch {
              /* Wait for close. */
            }
          }
        });
      } catch {
        complete({ kind: "failed", operation, reason: "binary_untrusted" });
      } finally {
        clearTimeout(timer);
        try {
          await file?.close();
        } catch {
          /* No capability or success from cleanup. */
        }
        if (home) {
          try {
            await rm(home, { recursive: true, force: true });
          } catch {
            /* Private temporary state. */
          }
        }
        this.active = false;
        resolveExit();
      }
    };
    void work();
    return { result, exited, cancel: () => stop("cancelled") };
  }
}
export async function inspectInstalledAntigravity(
  probe: Pick<AntigravityMetadataProbe, "start">,
): Promise<{
  version: string;
  capabilities: AntigravityCliCapabilities;
  authentication: "unknown";
  modelAvailability: "unknown";
  zeroTools: "unverified";
  osConfinementVerified: false;
}> {
  const values: string[] = [];
  for (const operation of ["version", "help"] as const) {
    const lease = probe.start(operation);
    const result = await lease.result;
    // Failed observations return promptly; the probe itself retains exclusive ownership until exit.
    if (result.kind === "failed") throw new Error(`antigravity_probe_${result.reason}`);
    await lease.exited;
    if (result.stdout.trim() && result.stderr.trim())
      throw new Error("antigravity_probe_ambiguous_output");
    const output = result.stdout.trim() ? result.stdout : result.stderr;
    values.push(operation === "version" ? output.trim() : output);
  }
  const version = values[0] ?? "";
  return {
    version,
    capabilities: inspectAntigravityHelp(values[1] ?? "", version),
    authentication: "unknown",
    modelAvailability: "unknown",
    zeroTools: "unverified",
    osConfinementVerified: false,
  };
}
