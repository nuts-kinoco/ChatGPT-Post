/** Local archive records are never execution or provider-test evidence. */
import type { ArtifactRef, TaskSpec } from "../contracts/task-types.js";
import type { TaskRecord } from "../state/task-store.js";
import type { ArchiveInspectionV2, ArchivePinV2 } from "./route-types.js";
export interface ArchivePin {
  schema: "archive-pin-1";
  requestId: string;
  taskSpecHash: string;
  projectId: string;
  outputRoot: string;
  relativeDirectory: string;
}
export interface ArchiveEntry {
  logicalName: string;
  filename: string;
  relativePath: string;
  contentSha256: string;
  sizeBytes: number;
  artifactId: string | null;
  complete: true;
}
export interface ArchiveManifest {
  schema: "artifact-archive-1";
  requestId: string;
  taskSpecHash: string;
  runId: string | null;
  projectId: string;
  localPinnedRoot: string;
  relativeDirectory: string;
  resultSha256: string;
  synthetic: boolean;
  completeness: "complete";
  entries: ArchiveEntry[];
}
export interface ArchiveInspection {
  state: "not_archived" | "complete" | "unavailable" | "corrupt";
  pin: ArchivePin;
  manifest: ArchiveManifest | null;
  manifestSha256: string | null;
  issue: string | null;
  reexecute: false;
}
export interface TaskArchivePort {
  reserve(
    task: TaskSpec,
    taskSpecHash: string,
    context?: {
      requesterId: string;
      worktreeRoot?: string;
      acceptedPreviously: boolean;
      projectRegistration?: {
        projectId: string;
        registryRevision: number;
        snapshotSha256: string;
      } | null;
    },
  ): ArchivePin | ArchivePinV2;
  archive(
    record: TaskRecord,
    readArtifact: (ref: ArtifactRef) => Promise<Uint8Array>,
  ): Promise<ArchiveInspection | ArchiveInspectionV2>;
  inspect(requestId: string): ArchiveInspection | ArchiveInspectionV2;
}
export class ArchiveError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
    this.name = "ArchiveError";
  }
}
