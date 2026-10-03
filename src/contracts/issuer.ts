/** Detached issuer metadata; never execution approval, model authentication, or a task ledger. */

import type { PreparedComposerPreview } from "../ui/composer.js";
import type { ProjectRegistrationReference } from "./project-registry.js";
import { loadTaskSpec, parseStrictJsonBytes, sha256Bytes, verifyTaskFileBytes } from "./task.js";
export const MAX_ISSUER_RECORD_BYTES = 256 * 1024;
const HASH = /^[a-f0-9]{64}(?![\s\S])/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/;
const ACTOR = /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\s\S])/;
export function issuerRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new Error("issuer_record_invalid");
  return value as Record<string, unknown>;
}
function str(value: unknown, re: RegExp): string {
  if (typeof value !== "string" || !re.test(value)) throw new Error("issuer_record_invalid");
  return value;
}
export function issuerTime(value: unknown): number {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("issuer_time_invalid");
  return Date.parse(value);
}
function ids(value: unknown, re: RegExp, max = 256): string[] {
  if (!Array.isArray(value) || !value.length || value.length > max)
    throw new Error("issuer_record_invalid");
  const out = value.map((v) => str(v, re));
  if (new Set(out).size !== out.length) throw new Error("issuer_record_invalid");
  return out;
}
function reference(value: unknown): ProjectRegistrationReference {
  const v = issuerRecord(value, ["projectId", "registryRevision", "snapshotSha256"]);
  str(v.projectId, UUID);
  str(v.snapshotSha256, HASH);
  if (!Number.isSafeInteger(v.registryRevision) || Number(v.registryRevision) < 1)
    throw new Error("issuer_record_invalid");
  return v as unknown as ProjectRegistrationReference;
}
export interface IssuerSessionBindingV1 {
  schema: "bridge-issuer-session-1";
  sessionId: string;
  requesterActorId: string;
  source: "configured_local_cli";
  providerObservation: "unverified";
  allowedProjectIds: string[];
  allowedDestinationIds: string[];
  expiresAt: string;
}
export function validateIssuerSession(value: unknown, now: Date): IssuerSessionBindingV1 {
  const v = issuerRecord(value, [
    "schema",
    "sessionId",
    "requesterActorId",
    "source",
    "providerObservation",
    "allowedProjectIds",
    "allowedDestinationIds",
    "expiresAt",
  ]);
  if (
    v.schema !== "bridge-issuer-session-1" ||
    v.source !== "configured_local_cli" ||
    v.providerObservation !== "unverified"
  )
    throw new Error("issuer_session_invalid");
  str(v.sessionId, UUID);
  str(v.requesterActorId, ACTOR);
  ids(v.allowedProjectIds, UUID);
  ids(v.allowedDestinationIds, ID);
  if (issuerTime(v.expiresAt) <= now.getTime()) throw new Error("issuer_session_expired");
  return structuredClone(v) as unknown as IssuerSessionBindingV1;
}
export const ISSUER_CAPABILITY_REASONS = [
  "unconfigured",
  "unsupported",
  "native_unavailable",
  "auth_unavailable",
  "approval_required",
  "quota_unknown",
  "quota_exhausted",
  "policy_denied",
  "expired",
  "busy",
  "revoked",
  "health_unknown",
  "version_unsupported",
  "context_unavailable",
  "human_verification_required",
] as const;
export interface RecipientCapabilityV1 {
  schema: "bridge-recipient-capability-1";
  recipientActorId: string;
  providerId: string;
  route: "cli" | "ordinary_chat_browser";
  destinationId: string;
  modelIds: string[];
  policySha256: string;
  projects: ProjectRegistrationReference[];
  observedAt: string;
  expiresAt: string;
  actions: {
    issue: { available: boolean; reason: string | null };
    start: { available: boolean; reason: string | null };
  };
}
export function validateRecipientCapability(value: unknown): RecipientCapabilityV1 {
  const v = issuerRecord(value, [
    "schema",
    "recipientActorId",
    "providerId",
    "route",
    "destinationId",
    "modelIds",
    "policySha256",
    "projects",
    "observedAt",
    "expiresAt",
    "actions",
  ]);
  if (
    v.schema !== "bridge-recipient-capability-1" ||
    typeof v.route !== "string" ||
    !["cli", "ordinary_chat_browser"].includes(v.route)
  )
    throw new Error("issuer_capability_invalid");
  str(v.recipientActorId, ACTOR);
  str(v.providerId, ID);
  str(v.destinationId, ID);
  str(v.policySha256, HASH);
  ids(v.modelIds, ID, 64);
  if (!Array.isArray(v.projects) || !v.projects.length || v.projects.length > 64)
    throw new Error("issuer_capability_invalid");
  const refs = v.projects.map(reference);
  if (new Set(refs.map((p) => p.projectId)).size !== refs.length)
    throw new Error("issuer_capability_invalid");
  const start = issuerTime(v.observedAt),
    end = issuerTime(v.expiresAt);
  if (end <= start || end - start > 60000) throw new Error("issuer_capability_time_invalid");
  const actions = issuerRecord(v.actions, ["issue", "start"]);
  for (const action of Object.values(actions)) {
    const a = issuerRecord(action, ["available", "reason"]);
    if (
      typeof a.available !== "boolean" ||
      (a.available
        ? a.reason !== null
        : !ISSUER_CAPABILITY_REASONS.includes(
            a.reason as (typeof ISSUER_CAPABILITY_REASONS)[number],
          ))
    )
      throw new Error("issuer_capability_invalid");
  }
  return structuredClone(v) as unknown as RecipientCapabilityV1;
}
export function assertCapabilityFresh(
  value: RecipientCapabilityV1,
  now: Date,
  maxAgeMs = 30000,
): void {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 60000)
    throw new Error("issuer_capability_age_invalid");
  const v = validateRecipientCapability(value),
    t = now.getTime(),
    observed = issuerTime(v.observedAt);
  if (observed > t || t - observed > maxAgeMs || issuerTime(v.expiresAt) <= t)
    throw new Error("issuer_capability_stale");
}
export interface IssuerPreparationV1 {
  schema: "bridge-issuer-preparation-1";
  preparationId: string;
  sessionId: string;
  requesterActorId: string;
  createdAt: string;
  expiresAt: string;
  preparedSha256: string;
  preparedBase64: string;
  capabilities: { destinationId: string; sha256: string; signedBase64: string }[];
}
export function strictBase64(value: unknown, maxBytes = MAX_ISSUER_RECORD_BYTES): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4)
    throw new Error("issuer_bytes_invalid");
  const b = Buffer.from(value, "base64");
  if (b.length > maxBytes || b.toString("base64") !== value)
    throw new Error("issuer_bytes_invalid");
  return b;
}
export function validateIssuerPreparation(value: unknown): IssuerPreparationV1 {
  const v = issuerRecord(value, [
    "schema",
    "preparationId",
    "sessionId",
    "requesterActorId",
    "createdAt",
    "expiresAt",
    "preparedSha256",
    "preparedBase64",
    "capabilities",
  ]);
  if (v.schema !== "bridge-issuer-preparation-1") throw new Error("issuer_preparation_invalid");
  str(v.preparationId, UUID);
  str(v.sessionId, UUID);
  str(v.requesterActorId, ACTOR);
  str(v.preparedSha256, HASH);
  const created = issuerTime(v.createdAt),
    expires = issuerTime(v.expiresAt);
  if (expires <= created || expires - created > 300000)
    throw new Error("issuer_preparation_time_invalid");
  const raw = strictBase64(v.preparedBase64);
  if (sha256Bytes(raw) !== v.preparedSha256) throw new Error("issuer_preparation_hash_invalid");
  const p = parsePreparedComposer(raw);
  if (p.preview.previewId !== v.preparationId || p.preview.expiresAt !== v.expiresAt)
    throw new Error("issuer_preparation_binding_invalid");
  if (!Array.isArray(v.capabilities) || v.capabilities.length !== p.preview.children.length)
    throw new Error("issuer_preparation_invalid");
  const seen = new Set();
  for (const c of v.capabilities) {
    const x = issuerRecord(c, ["destinationId", "sha256", "signedBase64"]);
    const id = str(x.destinationId, ID);
    str(x.sha256, HASH);
    const b = strictBase64(x.signedBase64, 32768);
    if (
      sha256Bytes(b) !== x.sha256 ||
      seen.has(id) ||
      !p.preview.children.some((c) => c.destinationId === id)
    )
      throw new Error("issuer_preparation_binding_invalid");
    seen.add(id);
  }
  return structuredClone(v) as unknown as IssuerPreparationV1;
}
export function parsePreparedComposer(bytes: Uint8Array): PreparedComposerPreview {
  if (bytes.length > MAX_ISSUER_RECORD_BYTES) throw new Error("issuer_record_too_large");
  const v = issuerRecord(parseStrictJsonBytes(bytes), ["preview", "catalogue", "promptFormats"]);
  const p = issuerRecord(v.preview, [
    "version",
    "previewId",
    "fanoutId",
    "registryRevision",
    "registrySha256",
    "projectId",
    "expiresAt",
    "children",
  ]);
  if (
    typeof p.version !== "string" ||
    !["bridge-composer-preview-1", "bridge-composer-preview-2"].includes(p.version)
  )
    throw new Error("issuer_preparation_invalid");
  str(p.previewId, UUID);
  str(p.projectId, UUID);
  str(p.registrySha256, HASH);
  issuerTime(p.expiresAt);
  if (
    !Number.isSafeInteger(p.registryRevision) ||
    Number(p.registryRevision) < 1 ||
    !Array.isArray(p.children) ||
    p.children.length < 1 ||
    p.children.length > 4
  )
    throw new Error("issuer_preparation_invalid");
  if (p.children.length > 1) str(p.fanoutId, UUID);
  else if (p.fanoutId !== null) throw new Error("issuer_preparation_invalid");
  if (
    !Array.isArray(v.catalogue) ||
    !Array.isArray(v.promptFormats) ||
    v.catalogue.length !== p.children.length ||
    v.promptFormats.length !== p.children.length
  )
    throw new Error("issuer_preparation_invalid");
  for (const x of [...v.catalogue, ...v.promptFormats]) str(x, HASH);
  const seen = new Set([p.previewId, ...(p.fanoutId ? [p.fanoutId] : [])]);
  const destinations = new Set();
  for (const child of p.children) {
    if (!child || typeof child !== "object" || Array.isArray(child))
      throw new Error("issuer_preparation_invalid");
    const c = child as Record<string, unknown>;
    issuerRecord(c, [
      "destinationId",
      "recipientActorId",
      "route",
      "requestId",
      "taskSpecHash",
      "taskFileHash",
      "rawSpec",
      "taskMarkdown",
      ...["outputPolicy", "promptFormat", "promptPreview"].filter((k) => Object.hasOwn(c, k)),
    ]);
    str(c.destinationId, ID);
    str(c.recipientActorId, ACTOR);
    str(c.requestId, UUID);
    str(c.taskSpecHash, HASH);
    str(c.taskFileHash, HASH);
    if (
      seen.has(c.requestId) ||
      destinations.has(c.destinationId) ||
      typeof c.route !== "string" ||
      !["cli", "ordinary_chat_browser"].includes(c.route) ||
      typeof c.rawSpec !== "string" ||
      typeof c.taskMarkdown !== "string"
    )
      throw new Error("issuer_preparation_invalid");
    seen.add(c.requestId);
    destinations.add(c.destinationId);
    const raw = Buffer.from(c.rawSpec),
      md = Buffer.from(c.taskMarkdown),
      parsed = loadTaskSpec(raw);
    if (
      !parsed.valid ||
      parsed.task.mode === "design_fixture" ||
      parsed.task.request_id !== c.requestId ||
      parsed.taskSpecHash !== c.taskSpecHash ||
      sha256Bytes(md) !== c.taskFileHash ||
      !verifyTaskFileBytes(parsed.task, md).valid
    )
      throw new Error("issuer_preparation_binding_invalid");
  }
  return v as unknown as PreparedComposerPreview;
}
export type IssuerBusMessage =
  | { kind: "issuer_capability"; capability: RecipientCapabilityV1 }
  | { kind: "issuer_preparation"; preparation: IssuerPreparationV1 };
