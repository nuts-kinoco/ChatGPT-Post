import { relative, resolve, sep } from "node:path";
/** Adapter preserves frozen local TaskSpec/ResultSpec; versioned archive data is detached. */
import {
  loadTaskSpec,
  serializeTaskResult,
  sha256Bytes,
  taskResultArtifactRefs,
  validateTaskResult,
  verifyTaskFileBytes,
} from "../contracts/task.js";
import type { ArtifactRef, TaskSpec } from "../contracts/task-types.js";
import type { TaskRecord, TaskStore } from "../state/task-store.js";
import type { RouteArtifactArchive } from "./route-store.js";
import type { ArchivePinV2, ArchiveSourceV1, JobAdmissionV1 } from "./route-types.js";
import { ArchiveError, type TaskArchivePort } from "./types.js";
export class LocalRouteArchive implements TaskArchivePort {
  constructor(
    readonly archiveStore: RouteArtifactArchive,
    private readonly store: TaskStore,
    private readonly binding: { recipientActorId: string; sessionId: string; executorId: string },
  ) {}
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
  ): ArchivePinV2 {
    if (!context) throw new ArchiveError("archive_admission_context_required");
    if (this.archiveStore.hasPin(task.request_id)) {
      const old = this.archiveStore.admission(task.request_id);
      if (
        old.taskSpecHash !== taskSpecHash ||
        old.taskFileHash !== task.task_file_hash ||
        old.requesterActorId !== context.requesterId ||
        old.recipientActorId !== this.binding.recipientActorId ||
        old.route.kind !== "local_execution" ||
        old.route.sessionId !== this.binding.sessionId ||
        old.route.executorId !== this.binding.executorId
      )
        throw new ArchiveError("archive_admission_conflict");
      return this.archiveStore.reserve(old, context.acceptedPreviously);
    }
    if (context.acceptedPreviously) throw new ArchiveError("archive_legacy_admission_unpinned");
    if (context.projectRegistration === null)
      throw new ArchiveError("archive_legacy_registry_unbound");
    const revision =
        context.projectRegistration?.registryRevision ??
        this.archiveStore.registry.currentRevision(),
      project = this.archiveStore.registry.resolve(revision, task.repo);
    if (
      context.projectRegistration &&
      (context.projectRegistration.projectId !== project.projectId ||
        context.projectRegistration.snapshotSha256 !==
          this.archiveStore.registry.snapshotHash(revision))
    )
      throw new ArchiveError("archive_registry_binding_mismatch");
    if (!context.worktreeRoot) throw new ArchiveError("archive_workspace_binding_required");
    const outputRoot =
      project.outputRootOverride ?? this.archiveStore.registry.defaultOutputRoot(revision);
    if (outputRoot) {
      const target = resolve(
          outputRoot,
          "ChatGPT-Bridge",
          "projects",
          project.storageSlug,
          "requests",
          task.request_id,
        ),
        within = relative(context.worktreeRoot, target);
      if (
        within === "" ||
        (within !== ".." && !within.startsWith(`..${sep}`) && !within.startsWith(sep))
      )
        throw new ArchiveError("archive_inside_worktree_denied");
    }
    const admission: JobAdmissionV1 = {
      schema: "job-admission-1",
      requestId: task.request_id,
      taskSpecHash,
      taskFileHash: task.task_file_hash,
      outputContractSha256: null,
      registryRevision: revision,
      registrySnapshotHash: this.archiveStore.registry.snapshotHash(revision),
      projectId: project.projectId,
      repoId: task.repo,
      storageSlug: project.storageSlug,
      requesterActorId: context.requesterId,
      recipientActorId: this.binding.recipientActorId,
      route: {
        kind: "local_execution",
        policyHash: task.policy_snapshot_sha256,
        sessionId: this.binding.sessionId,
        executorId: this.binding.executorId,
      },
    };
    return this.archiveStore.reserve(admission);
  }
  inspect(requestId: string) {
    return this.archiveStore.inspect(requestId);
  }
  async archive(record: TaskRecord, readArtifact: (ref: ArtifactRef) => Promise<Uint8Array>) {
    const pin = this.archiveStore.pin(record.result.request_id),
      admission = this.archiveStore.admission(record.result.request_id);
    const parsed = loadTaskSpec(Buffer.from(record.rawSpec), admission.taskSpecHash),
      taskBytes = Buffer.from(record.taskBytesBase64, "base64");
    if (
      !parsed.valid ||
      !verifyTaskFileBytes(parsed.task, taskBytes).valid ||
      !validateTaskResult(record.result, {
        task: parsed.task,
        taskSpecHash: admission.taskSpecHash,
      }).valid
    )
      throw new ArchiveError("archive_terminal_record_invalid");
    const payload = this.store.deliveryPayload(record.result.request_id);
    if (!Buffer.from(payload).equals(Buffer.from(serializeTaskResult(record.result))))
      throw new ArchiveError("archive_terminal_record_invalid");
    for (const event of this.store.events(record.result.request_id))
      this.archiveStore.appendProvenance(record.result.request_id, {
        schema: "job-provenance-1",
        admissionHash: pin.admissionHash,
        source: "local_ledger",
        sourceRevision: event.result.observation_seq,
        observedAt: event.result.observed_at,
        observation: {
          kind: "local_execution",
          runId: event.result.run_id,
          fencingToken: event.result.fencing_token,
          resultSha256: sha256Bytes(Buffer.from(serializeTaskResult(event.result))),
          processIdentitySha256: event.result.process_identity
            ? sha256Bytes(Buffer.from(JSON.stringify(event.result.process_identity)))
            : null,
        },
      });
    const refs = new Map<string, ArtifactRef>();
    for (const ref of taskResultArtifactRefs(record.result)) {
      const prior = refs.get(ref.artifact_id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(ref))
        throw new ArchiveError("archive_artifact_identity_conflict");
      refs.set(ref.artifact_id, ref);
    }
    const inspection = await this.archiveStore.archive(
      {
        requestId: record.result.request_id,
        taskSpecBytes: Buffer.from(record.rawSpec),
        taskFileBytes: taskBytes,
        payloadBytes: payload,
        synthetic: record.result.synthetic,
        requiredSetKnown: true,
        items: [...refs.values()].map((ref) => ({
          artifactId: ref.artifact_id,
          logicalName: `artifact:${ref.artifact_id}`,
          required: true,
          contentSha256: ref.sha256,
          sizeBytes: ref.size_bytes,
          source: {
            kind: this.store.readLocalEvidence(ref) ? "local_ledger_evidence" : "executor_artifact",
            artifactId: ref.artifact_id,
          } as ArchiveSourceV1,
        })),
      },
      {
        read: async (source) => {
          if (source.kind !== "local_ledger_evidence" && source.kind !== "executor_artifact")
            throw new ArchiveError("archive_source_unsupported");
          const ref = refs.get(source.artifactId);
          if (!ref) throw new ArchiveError("archive_source_identity_mismatch");
          return source.kind === "local_ledger_evidence"
            ? (this.store.readLocalEvidence(ref) ??
                Promise.reject(new ArchiveError("archive_source_unavailable")))
            : readArtifact(ref);
        },
      },
    );
    if (inspection.state !== "complete")
      throw new ArchiveError(inspection.issue ?? "archive_incomplete", true);
    return inspection;
  }
}
