import type { ProjectRegistration, ProjectRegistryPort } from "../contracts/project-registry.js";
import type { OwnedRootIdentity } from "./durable.js";
export type ArchiveProjectRegistration = ProjectRegistration;
export type ArchiveRegistryPort = ProjectRegistryPort;
export interface JobAdmissionV1 {
  schema: "job-admission-1";
  requestId: string;
  taskSpecHash: string;
  taskFileHash: string;
  outputContractSha256: string | null;
  registryRevision: number;
  registrySnapshotHash: string;
  projectId: string;
  repoId: string;
  storageSlug: string;
  requesterActorId: string;
  recipientActorId: string;
  route:
    | { kind: "local_execution"; policyHash: string; sessionId: string; executorId: string }
    | {
        kind: "hosted_delivery";
        policyHash: string;
        conversationId: string;
        destinationId: string;
      };
}
export interface ArchivePinV2 {
  schema: "archive-pin-2";
  admissionHash: string;
  requestId: string;
  registryRevision: number;
  registrySnapshotHash: string;
  projectId: string;
  repoId: string;
  storageSlug: string;
  localPinnedRoot: string;
  rootIdentity: OwnedRootIdentity;
  relativeDirectory: string;
}
export type ArchiveSourceV1 =
  | { kind: "hosted_admission_evidence"; artifactId: "hosted-output-contract" }
  | { kind: "local_ledger_evidence" | "executor_artifact"; artifactId: string }
  | { kind: "hosted_response"; conversationId: string; userTurnId: string; assistantTurnId: string }
  | {
      kind: "hosted_message_artifact";
      conversationId: string;
      userTurnId: string;
      assistantTurnId: string;
      artifactId: string;
    };
export interface ArchiveSourceReaderV1 {
  read(
    source: ArchiveSourceV1,
    expected: { contentSha256: string; sizeBytes: number },
  ): Promise<Uint8Array>;
}
export interface JobProvenanceEventV1 {
  schema: "job-provenance-1";
  admissionHash: string;
  source: "local_ledger" | "hosted_ledger" | "requester_materializer" | "transport_ack";
  sourceRevision: number;
  observedAt: string;
  observation:
    | {
        kind: "local_execution";
        runId: string | null;
        fencingToken: number;
        resultSha256: string | null;
        processIdentitySha256: string | null;
      }
    | {
        kind: "hosted_delivery";
        attemptId: string | null;
        conversationId: string;
        userTurnId: string | null;
        assistantTurnId: string | null;
        rawSha256: string | null;
        bodySha256: string | null;
        resultSha256: string | null;
      }
    | {
        kind: "materialization" | "ack";
        terminalEventId: string;
        payloadSha256: string;
        receiptSha256: string;
      };
}
export interface ArchiveItemV2 {
  artifactId: string;
  logicalName: string;
  filename: string;
  required: boolean;
  source: ArchiveSourceV1 | null;
  contentSha256: string | null;
  sizeBytes: number | null;
  state: "complete" | "unavailable";
  unavailableReason: string | null;
  relativePath: string | null;
}
export interface ArtifactArchiveManifestV2 {
  schema: "artifact-archive-2";
  admission: JobAdmissionV1;
  admissionHash: string;
  pin: ArchivePinV2;
  provenance: JobProvenanceEventV1[];
  instructions: {
    taskSpecPath: "instructions/TaskSpec.json";
    taskFilePath: "instructions/task.md";
  };
  payload: { contentSha256: string; sizeBytes: number; relativePath: "results/result.json" };
  items: ArchiveItemV2[];
  requiredSetKnown: boolean;
  complete: boolean;
  synthetic: boolean;
}
export interface ArchiveSnapshotV2 {
  requestId: string;
  taskSpecBytes: Uint8Array;
  taskFileBytes: Uint8Array;
  payloadBytes: Uint8Array;
  synthetic: boolean;
  requiredSetKnown: boolean;
  items: {
    artifactId: string;
    logicalName: string;
    required: boolean;
    source: ArchiveSourceV1 | null;
    contentSha256: string | null;
    sizeBytes: number | null;
    unavailableReason?: string;
  }[];
}
export interface ArchiveInspectionV2 {
  schema: "archive-inspection-2";
  state: "not_archived" | "complete" | "incomplete" | "unavailable" | "corrupt";
  pin: ArchivePinV2;
  manifest: ArtifactArchiveManifestV2 | null;
  manifestSha256: string | null;
  issue: string | null;
  reexecute: false;
}
