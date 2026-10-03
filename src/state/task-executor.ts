/** Only this port may talk to a future process broker. No shell or model CLI fallback exists. */
import type {
  ArtifactRef,
  ProcessIdentity,
  ResultSpec,
  TaskSpec,
} from "../contracts/task-types.js";
import type { RunIntent } from "./task-store.js";

export interface ExecutionIdentity {
  requestId: string;
  taskSpecHash: string;
  runId: string;
  fencingToken: number;
}
export type ExecutorObservation =
  | { kind: "unknown"; identity: ExecutionIdentity; reason: string }
  | {
      kind: "running";
      identity: ExecutionIdentity;
      process: ProcessIdentity;
      startedAt: string;
      actualAgent: string;
      actualModel: string;
    }
  | { kind: "terminal"; identity: ExecutionIdentity; result: ResultSpec; allTerminated: boolean };
export interface TaskExecutor {
  readonly executorId: string;
  readonly synthetic: boolean;
  /** Must reject unless this installed adapter actually confines every task operation. A promise
   * in task.md, cwd, preflight allowlists, or an agent CLI permission prompt is not enforcement. */
  checkCapabilities(task: TaskSpec): Promise<void>;
  /** The broker must durably deduplicate (requestId,runId,fence) and enforce the deadline even
   * while the caller is disconnected. A start timeout is UNKNOWN, never permission to restart. */
  start(
    task: TaskSpec,
    taskBytes: Uint8Array,
    identity: ExecutionIdentity,
    intent: RunIntent,
  ): Promise<ExecutorObservation>;
  status(identity: ExecutionIdentity): Promise<ExecutorObservation>;
  /** Bounded, idempotent RPC. Persist a cancellation tombstone even before start registration;
   * a later start with this identity must never escape cancellation. */
  cancel(
    identity: ExecutionIdentity,
    reason: "user" | "timeout",
    graceSeconds: number,
  ): Promise<ExecutorObservation>;
  collect(identity: ExecutionIdentity): Promise<ExecutorObservation>;
  /** Bytes must come from a trusted broker evidence channel, never agent text or task paths. */
  readArtifact(ref: ArtifactRef): Promise<Uint8Array>;
}
export class UnavailableTaskExecutor implements TaskExecutor {
  readonly executorId = "unavailable";
  readonly synthetic = false;
  private denied(): never {
    throw new Error("sandbox_capability_unavailable");
  }
  async checkCapabilities(): Promise<void> {
    this.denied();
  }
  async start(): Promise<ExecutorObservation> {
    return this.denied();
  }
  async status(): Promise<ExecutorObservation> {
    return this.denied();
  }
  async cancel(): Promise<ExecutorObservation> {
    return this.denied();
  }
  async collect(): Promise<ExecutorObservation> {
    return this.denied();
  }
  async readArtifact(): Promise<Uint8Array> {
    return this.denied();
  }
}
