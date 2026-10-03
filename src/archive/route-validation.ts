import { sha256Bytes } from "../contracts/task.js";
import type { ArchiveSourceV1, JobAdmissionV1, JobProvenanceEventV1 } from "./route-types.js";
import { ArchiveError } from "./types.js";
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/;
export const HASH = /^[a-f0-9]{64}(?![\s\S])/;
export const ID = /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/;
export const MESSAGE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}(?![\s\S])/;
export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw new ArchiveError("archive_contract_invalid");
  return value as Record<string, unknown>;
}
function matches(re: RegExp, value: unknown): boolean {
  return typeof value === "string" && re.test(value);
}
export function admissionDigest(value: JobAdmissionV1): string {
  validateAdmission(value);
  return sha256Bytes(Buffer.from(JSON.stringify(value)));
}
export function validateAdmission(value: JobAdmissionV1): void {
  exact(value, [
    "schema",
    "requestId",
    "taskSpecHash",
    "taskFileHash",
    "outputContractSha256",
    "registryRevision",
    "registrySnapshotHash",
    "projectId",
    "repoId",
    "storageSlug",
    "requesterActorId",
    "recipientActorId",
    "route",
  ]);
  if (
    value.schema !== "job-admission-1" ||
    !matches(UUID, value.requestId) ||
    !matches(HASH, value.taskSpecHash) ||
    !matches(HASH, value.taskFileHash) ||
    (value.outputContractSha256 !== null && !matches(HASH, value.outputContractSha256)) ||
    !matches(UUID, value.projectId) ||
    !matches(ID, value.repoId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/.test(value.storageSlug) ||
    !matches(ID, value.requesterActorId) ||
    !matches(ID, value.recipientActorId) ||
    !Number.isSafeInteger(value.registryRevision) ||
    value.registryRevision < 1 ||
    !matches(HASH, value.registrySnapshotHash)
  )
    throw new ArchiveError("archive_admission_invalid");
  if (value.route.kind === "local_execution") {
    exact(value.route, ["kind", "policyHash", "sessionId", "executorId"]);
    if (!matches(UUID, value.route.sessionId) || !matches(ID, value.route.executorId))
      throw new ArchiveError("archive_admission_invalid");
  } else if (value.route.kind === "hosted_delivery") {
    exact(value.route, ["kind", "policyHash", "conversationId", "destinationId"]);
    if (!matches(MESSAGE_ID, value.route.conversationId) || !matches(ID, value.route.destinationId))
      throw new ArchiveError("archive_admission_invalid");
  } else throw new ArchiveError("archive_route_unsupported");
  if (!matches(HASH, value.route.policyHash)) throw new ArchiveError("archive_admission_invalid");
}
export function validateSource(source: ArchiveSourceV1): void {
  if (source.kind === "hosted_admission_evidence") {
    exact(source, ["kind", "artifactId"]);
    if (source.artifactId !== "hosted-output-contract")
      throw new ArchiveError("archive_source_invalid");
  } else if (source.kind === "local_ledger_evidence" || source.kind === "executor_artifact")
    exact(source, ["kind", "artifactId"]);
  else if (source.kind === "hosted_response")
    exact(source, ["kind", "conversationId", "userTurnId", "assistantTurnId"]);
  else if (source.kind === "hosted_message_artifact")
    exact(source, ["kind", "conversationId", "userTurnId", "assistantTurnId", "artifactId"]);
  else throw new ArchiveError("archive_source_unsupported");
  for (const [key, value] of Object.entries(source))
    if (key !== "kind" && !matches(MESSAGE_ID, value))
      throw new ArchiveError("archive_source_invalid");
}
export function validateProvenance(value: JobProvenanceEventV1, admission: JobAdmissionV1): void {
  exact(value, [
    "schema",
    "admissionHash",
    "source",
    "sourceRevision",
    "observedAt",
    "observation",
  ]);
  if (
    value.schema !== "job-provenance-1" ||
    value.admissionHash !== admissionDigest(admission) ||
    !["local_ledger", "hosted_ledger", "requester_materializer", "transport_ack"].includes(
      value.source,
    ) ||
    !Number.isSafeInteger(value.sourceRevision) ||
    value.sourceRevision < 1 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?![\s\S])/.test(value.observedAt) ||
    !Number.isFinite(Date.parse(value.observedAt))
  )
    throw new ArchiveError("archive_provenance_invalid");
  const o = value.observation;
  if (o.kind === "local_execution") {
    exact(o, ["kind", "runId", "fencingToken", "resultSha256", "processIdentitySha256"]);
    if (
      admission.route.kind !== o.kind ||
      value.source !== "local_ledger" ||
      (o.runId !== null && !matches(UUID, o.runId)) ||
      !Number.isSafeInteger(o.fencingToken) ||
      o.fencingToken < 0 ||
      (o.resultSha256 !== null && !matches(HASH, o.resultSha256)) ||
      (o.processIdentitySha256 !== null && !matches(HASH, o.processIdentitySha256))
    )
      throw new ArchiveError("archive_provenance_invalid");
  } else if (o.kind === "hosted_delivery") {
    exact(o, [
      "kind",
      "attemptId",
      "conversationId",
      "userTurnId",
      "assistantTurnId",
      "rawSha256",
      "bodySha256",
      "resultSha256",
    ]);
    if (
      admission.route.kind !== o.kind ||
      value.source !== "hosted_ledger" ||
      o.conversationId !== admission.route.conversationId ||
      (o.attemptId !== null && !matches(UUID, o.attemptId)) ||
      [o.userTurnId, o.assistantTurnId].some((v) => v !== null && !matches(MESSAGE_ID, v)) ||
      [o.rawSha256, o.bodySha256, o.resultSha256].some((v) => v !== null && !matches(HASH, v))
    )
      throw new ArchiveError("archive_provenance_invalid");
  } else if (o.kind === "materialization" || o.kind === "ack") {
    exact(o, ["kind", "terminalEventId", "payloadSha256", "receiptSha256"]);
    if (
      !matches(UUID, o.terminalEventId) ||
      !matches(HASH, o.payloadSha256) ||
      !matches(HASH, o.receiptSha256) ||
      value.source !== (o.kind === "ack" ? "transport_ack" : "requester_materializer")
    )
      throw new ArchiveError("archive_provenance_invalid");
  } else throw new ArchiveError("archive_provenance_invalid");
}
