/** An explicit, local-only export projection. It never reads files, runs providers, or uploads.
 * Inputs are untrusted snapshots, not evidence. Unknown fields are omitted, never string-redacted.
 */
import { createHash } from "node:crypto";
import { types } from "node:util";
import type { TaskResult, TaskStatus } from "../contracts/task-types.js";

export const DIAGNOSTIC_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  stringBytes: 2 * 1024 * 1024,
  collectionItems: 1024,
  objectFields: 1024,
  depth: 32,
  nodes: 50_000,
});

export const DIAGNOSTIC_DISCLOSURE = Object.freeze({
  included: Object.freeze([
    "allowlisted protocol, status, boolean and aggregate count fields",
    "validated reported SHA-256 digests and archive entry byte sizes",
    "domain-separated SHA-256 pseudonyms of request, run and artifact identifiers",
    "reported synthetic flag and explicitly unverified provider execution",
    "caller-reported archive verification state, not verification performed by this export",
    "redaction audit counts and SHA-256 of canonical diagnostic content",
    "allowlisted runtime versions, platform, architecture, stage times and static error codes",
    "caller-reported stage observations and ACK metadata, with missing values explicit",
  ]),
  excluded: Object.freeze([
    "raw prompts, task Markdown, raw task specifications and instructions",
    "environment variables, secrets, tokens, credentials, cookies and authorization headers",
    "URLs, local paths, filenames, repository names and archive output roots",
    "artifact content, stdout, stderr, diffs and command argv",
    "free-text errors, unrecognized error codes, stack traces and function source",
    "raw identifiers, agent/model names, non-stage timestamps and process identity",
    "all unknown fields, including nested fields and field names",
  ]),
  limitations: Object.freeze([
    "This is a deterministic allowlist projection, not a secret detector or anonymization guarantee",
    "Pseudonyms and digests permit correlation and may allow guesses of low-entropy inputs",
    "Reported status, digests and synthetic flags are not authenticated by this export",
    "Neither export integrity nor archive verification proves a real provider run",
  ]),
});

export interface DiagnosticInput {
  /** A TaskRecord from task-store; unknown at the boundary deliberately requires runtime checks. */
  record: unknown;
  /** Optional ArchiveManifest, never artifact content. */
  manifest?: unknown;
  /** Trusted caller may report a completed local archive check; this core does not perform it. */
  archiveVerification?: { state: "not_checked" | "verified" | "rejected"; issue?: string | null };
  environment?: { bridgeVersion: string; nodeVersion: string; platform: string; arch: string };
  /** Ordered observations from the ledger, not reconstructed or inferred execution history. */
  stages?: unknown;
  /** Persisted TaskHandshake for result_ack. Null means absent; omitted means not checked. */
  ack?: unknown;
}

const STAGES = [
  "receive",
  "approval",
  "start",
  "execution",
  "result",
  "archive",
  "delivery",
  "ack",
] as const;
const STAGE_STATES = ["observed", "pending", "succeeded", "failed", "unknown"] as const;
const ERROR_CODES = [
  "INTERNAL_ERROR",
  "cancelled_before_start",
  "dispatch_unconfirmed",
  "reconciliation_required",
  "run_timeout",
  "cancellation_committed_first",
  "synthetic_termination",
  "archive_path_missing",
  "archive_permission_denied",
  "archive_disk_full",
  "archive_artifact_hash_mismatch",
  "archive_artifact_identity_conflict",
  "archive_content_hash_mismatch",
  "archive_explicit_action_required",
  "archive_file_changed",
  "archive_file_partial",
  "archive_file_unsafe",
  "archive_filename_invalid",
  "archive_identity_invalid",
  "archive_manifest_conflict",
  "archive_manifest_hash_mismatch",
  "archive_manifest_invalid",
  "archive_path_escape",
  "archive_path_not_owned",
  "archive_pin_missing",
  "archive_project_conflict",
  "archive_project_invalid",
  "archive_project_unregistered",
  "archive_publish_conflict",
  "archive_request_conflict",
  "archive_result_conflict",
  "archive_root_invalid",
  "archive_root_unconfigured",
  "archive_settings_invalid",
  "archive_settings_stale",
  "archive_size_limit",
  "archive_terminal_record_invalid",
  "archive_windows_ownership_unverified",
] as const;
type KnownError = (typeof ERROR_CODES)[number] | "unrecognized_omitted" | null;

const README = [
  "Bridge sanitized diagnostic bundle, schema bridge-sanitized-diagnostics-1.",
  "This single JSON file is self-contained for a new reviewer. Start with task, environment, stage_timeline, expected_vs_actual, known_errors, and missing_data. No prior conversation is required to interpret these fields. Null means unavailable or invalid, not success. Empty stage events provide no historical evidence; no events have been invented.",
  "All task status, synthetic flags, ACKs, archive metadata and stage observations are caller-reported. A synthetic run is a fixture. reported_non_synthetic_unverified does not prove a provider ran. Source result verification and archive byte verification are separate from provider execution verification. This exporter verifies neither execution nor the archive and never diagnoses a cause from a status alone.",
  "The stage timeline is sorted by reported ledger sequence, then input order for ties; observed_at is a strictly checked UTC timestamp or null. ACK presence does not prove recipient identity or delivery authentication. Expected-vs-actual entries are reference metadata checks, not the task's private success criteria.",
  "Artifact references are linked by validated content SHA-256 and hashed artifact identifier. Request and run pseudonyms correlate across the task, manifest and ACK. Identifiers use SHA-256 of bridge-diagnostic-id-v1 + NUL + kind + NUL + original UTF-8 identifier. Kinds are request, run, artifact and event. Original IDs, filenames, paths and artifact contents are excluded. Keep any local mapping private. Hashes and pseudonyms are correlatable and do not guarantee anonymity.",
  "Read-only reproduction conditions: use the same original local ledger snapshot, archive manifest, stage observations, ACK and runtime metadata. Inspect the corresponding task on its original host without starting or retrying it. Run only the existing read-only archive inspection to compare bytes with the manifest, then explicitly export diagnostics again. Missing inputs must be supplied from that host; do not invent them. This bundle cannot reproduce model behavior because prompts, commands and artifact bodies are intentionally absent.",
  "Integrity check: recursively sort object keys, preserve array order, serialize compact JSON of content as UTF-8 with no trailing newline, and SHA-256 it. Compare with content_sha256. The full file is canonical envelope JSON followed by one LF. A matching digest proves consistency of these bytes, not origin, execution or authenticity.",
  "The redaction audit counts inspected input fields and scalar leaves, scalar values used for allowlisted summaries, identifiers hashed, omitted scalar leaves, and invalid allowlisted fields. It does not count detected secrets. Omission is the default for every unknown field, including nested field names. Review the included/excluded lists before sharing this file; sharing is a separate user decision.",
].join("\n\n");

interface DiagnosticAck {
  observation: "not_provided" | "absent" | "reported" | "invalid";
  stage: "result_ack" | null;
  event_id_sha256: string | null;
  request_id_sha256: string | null;
  run_id_sha256: string | null;
  task_spec_sha256: string | null;
  payload_sha256: string | null;
  sequence: number | null;
}

export interface DiagnosticAudit {
  input_fields: number;
  input_scalar_values: number;
  scalar_values_used: number;
  identifiers_hashed: number;
  scalar_values_omitted: number;
  invalid_allowlisted_fields: number;
}

export interface DiagnosticManifest {
  schema: "artifact-archive-1" | null;
  request_id_sha256: string | null;
  run_id_sha256: string | null;
  task_spec_sha256: string | null;
  result_sha256: string | null;
  synthetic: boolean | null;
  completeness: "complete" | null;
  entry_count: number;
  entries: {
    content_sha256: string | null;
    size_bytes: number | null;
    artifact_id_sha256: string | null;
    complete: boolean | null;
  }[];
}

export interface SanitizedDiagnosticContent {
  readme: string;
  disclosure: typeof DIAGNOSTIC_DISCLOSURE;
  environment: {
    bridge_version: string | null;
    node_version: string | null;
    platform: string | null;
    arch: string | null;
  };
  stage_timeline: {
    source: "caller_reported" | "not_provided" | "invalid";
    order: "reported_sequence_ascending_then_input_order";
    events: {
      stage: (typeof STAGES)[number] | null;
      state: (typeof STAGE_STATES)[number] | null;
      sequence: number | null;
      observed_at: string | null;
    }[];
  };
  delivery_ack: DiagnosticAck;
  expected_vs_actual: { check: string; expected: string; actual: string }[];
  known_errors: { task: KnownError; archive: KnownError };
  missing_data: string[];
  task: {
    protocol_version: "2.0" | null;
    request_id_sha256: string | null;
    run_id_sha256: string | null;
    task_spec_sha256: string | null;
    task_file_sha256: string | null;
    status: TaskStatus | null;
    last_confirmed_status: Exclude<TaskStatus, "unknown"> | null;
    synthetic: boolean | null;
    observation_seq: number | null;
    outcome_known: boolean | null;
    commands: Record<
      TaskResult["commands_run"][number]["termination"] | "invalid" | "total",
      number
    >;
    tests: Record<TaskResult["tests"][number]["outcome"] | "invalid" | "total", number>;
    changed_files: Record<
      TaskResult["changed_files"][number]["change"] | "invalid" | "total",
      number
    >;
    error_present: boolean;
  };
  manifest: DiagnosticManifest | null;
  verification: {
    source_result_state: TaskResult["verification"]["state"] | null;
    execution_kind: "synthetic" | "reported_non_synthetic_unverified" | "unknown";
    provider_run: "not_verified_by_export";
    archive: {
      reported_state: "not_checked" | "verified" | "rejected";
      verified_by_export: false;
    };
  };
  redaction_audit: DiagnosticAudit;
}

export interface SanitizedDiagnosticEnvelope {
  schema: "bridge-sanitized-diagnostics-1";
  /** SHA-256 of canonical JSON of content, without a trailing newline. */
  content_sha256: string;
  content: SanitizedDiagnosticContent;
}

export interface SanitizedDiagnosticExport {
  /** UTF-8 canonical envelope JSON with exactly one trailing LF. */
  bytes: Uint8Array;
  /** SHA-256 of the complete exported bytes, distinct from contentSha256. */
  sha256: string;
  contentSha256: string;
  envelope: SanitizedDiagnosticEnvelope;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
const STATUSES = [
  "received",
  "awaiting_approval",
  "approved",
  "running",
  "cancel_requested",
  "cancelled",
  "succeeded",
  "failed",
  "unknown",
] as const satisfies readonly TaskStatus[];
const SHA256 = /^[0-9a-f]{64}(?![\s\S])/;
const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export class DiagnosticExportError extends Error {
  constructor(
    readonly code:
      | "diagnostic_action_required"
      | "diagnostic_input_invalid"
      | "diagnostic_input_limit",
  ) {
    super(code);
    this.name = "DiagnosticExportError";
  }
}

function fail(code: DiagnosticExportError["code"]): never {
  throw new DiagnosticExportError(code);
}

function object(value: Json | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Do not invoke getters, proxies, toJSON, functions, or exception formatting on input.
 * Snapshot before projection prevents object mutation between validation and extraction.
 * The byte budget counts JSON encoding, including discarded keys and string escapes.
 */
function boundedSnapshot(input: unknown, audit: DiagnosticAudit): Json {
  let bytes = 0;
  let nodes = 0;
  const active = new Set<object>();
  const add = (count: number): void => {
    bytes += count;
    if (bytes > DIAGNOSTIC_LIMITS.inputBytes) fail("diagnostic_input_limit");
  };
  const stringSize = (value: string): number => {
    if (
      value.length > DIAGNOSTIC_LIMITS.stringBytes ||
      Buffer.byteLength(value) > DIAGNOSTIC_LIMITS.stringBytes
    )
      fail("diagnostic_input_limit");
    return Buffer.byteLength(JSON.stringify(value));
  };
  const visit = (value: unknown, depth: number): Json => {
    if (++nodes > DIAGNOSTIC_LIMITS.nodes || depth > DIAGNOSTIC_LIMITS.depth)
      fail("diagnostic_input_limit");
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string" ||
      typeof value === "number"
    ) {
      if (typeof value === "number" && !Number.isSafeInteger(value))
        fail("diagnostic_input_invalid");
      add(typeof value === "string" ? stringSize(value) : String(value).length);
      audit.input_scalar_values++;
      return value;
    }
    if (typeof value !== "object" || types.isProxy(value)) fail("diagnostic_input_invalid");
    if (active.has(value)) fail("diagnostic_input_invalid");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      (!array && prototype !== Object.prototype && prototype !== null) ||
      (array && prototype !== Array.prototype)
    )
      fail("diagnostic_input_invalid");
    active.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) fail("diagnostic_input_invalid");
    add(2);
    if (array) {
      if (value.length > DIAGNOSTIC_LIMITS.collectionItems) fail("diagnostic_input_limit");
      if (keys.length !== value.length + 1) fail("diagnostic_input_invalid");
      const result: Json[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("diagnostic_input_invalid");
        if (index) add(1);
        result.push(visit(descriptor.value, depth + 1));
      }
      active.delete(value);
      return result;
    }
    if (keys.length > DIAGNOSTIC_LIMITS.objectFields) fail("diagnostic_input_limit");
    const result: JsonObject = Object.create(null) as JsonObject;
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] as string;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
        fail("diagnostic_input_invalid");
      audit.input_fields++;
      add(stringSize(key) + 1 + (index ? 1 : 0));
      result[key] = visit(descriptor.value, depth + 1);
    }
    active.delete(value);
    return result;
  };
  return visit(input, 0);
}

/** Only called on the constructed, fixed-schema output, never input objects. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

class Projection {
  constructor(readonly audit: DiagnosticAudit) {}
  private select<T extends Json>(value: Json | undefined, check: (v: Json) => v is T): T | null {
    if (value === undefined) return null;
    if (value !== null && check(value)) {
      this.audit.scalar_values_used++;
      return value;
    }
    if (value === null) this.audit.scalar_values_used++;
    else this.audit.invalid_allowlisted_fields++;
    return null;
  }
  enumeration<T extends string>(value: Json | undefined, allowed: readonly T[]): T | null {
    return this.select(value, (v): v is T => typeof v === "string" && allowed.includes(v as T));
  }
  boolean(value: Json | undefined): boolean | null {
    return this.select(value, (v): v is boolean => typeof v === "boolean");
  }
  integer(value: Json | undefined): number | null {
    return this.select(
      value,
      (v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
    );
  }
  hash(value: Json | undefined): string | null {
    return this.select(value, (v): v is string => typeof v === "string" && SHA256.test(v));
  }
  version(value: Json | undefined): string | null {
    return this.select(
      value,
      (v): v is string =>
        typeof v === "string" && /^v?[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?![\s\S])/.test(v),
    );
  }
  timestamp(value: Json | undefined): string | null {
    return this.select(value, (v): v is string => {
      if (
        typeof v !== "string" ||
        !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z(?![\s\S])/.test(v)
      )
        return false;
      const parsed = new Date(v);
      return (
        Number.isFinite(parsed.getTime()) &&
        parsed.toISOString() === (v.length === 20 ? `${v.slice(0, -1)}.000Z` : v)
      );
    });
  }
  errorCode(value: Json | undefined): KnownError {
    return (
      this.enumeration(value, ERROR_CODES) ??
      (value === undefined || value === null ? null : "unrecognized_omitted")
    );
  }
  identifier(
    value: Json | undefined,
    kind:
      | "request"
      | "run"
      | "artifact"
      | "event"
      | "attempt"
      | "conversation"
      | "user_turn"
      | "assistant_turn",
  ): string | null {
    if (value === undefined) return null;
    if (value === null) {
      this.audit.scalar_values_used++;
      return null;
    }
    if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > 1024) {
      this.audit.invalid_allowlisted_fields++;
      return null;
    }
    this.audit.identifiers_hashed++;
    return digest(`bridge-diagnostic-id-v1\0${kind}\0${value}`);
  }
  array(value: Json | undefined): Json[] {
    if (Array.isArray(value)) return value;
    if (value !== undefined) this.audit.invalid_allowlisted_fields++;
    return [];
  }
  stages(value: Json | undefined): SanitizedDiagnosticContent["stage_timeline"] {
    return {
      source:
        value === undefined ? "not_provided" : Array.isArray(value) ? "caller_reported" : "invalid",
      order: "reported_sequence_ascending_then_input_order",
      events: this.array(value)
        .map((item) => {
          const row = object(item);
          if (!row) this.audit.invalid_allowlisted_fields++;
          return {
            stage: this.enumeration(row?.stage, STAGES),
            state: this.enumeration(row?.state, STAGE_STATES),
            sequence: this.integer(row?.sequence),
            observed_at: this.timestamp(row?.observedAt),
          };
        })
        .sort(
          (a, b) =>
            (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER),
        ),
    };
  }
  ack(value: Json | undefined): DiagnosticAck {
    const row = object(value);
    if (value !== undefined && value !== null && !row) this.audit.invalid_allowlisted_fields++;
    return {
      observation:
        value === undefined
          ? "not_provided"
          : value === null
            ? "absent"
            : row
              ? "reported"
              : "invalid",
      stage: this.enumeration(row?.stage, ["result_ack"]),
      event_id_sha256: this.identifier(row?.eventId, "event"),
      request_id_sha256: this.identifier(row?.requestId, "request"),
      run_id_sha256: this.identifier(row?.runId, "run"),
      task_spec_sha256: this.hash(row?.taskSpecHash),
      payload_sha256: this.hash(row?.payloadSha256),
      sequence: this.integer(row?.sequence),
    };
  }
  histogram<T extends string>(
    value: Json | undefined,
    field: string,
    choices: readonly T[],
  ): Record<T | "invalid" | "total", number> {
    const items = this.array(value);
    const counts = Object.fromEntries(choices.map((choice) => [choice, 0])) as Record<
      T | "invalid" | "total",
      number
    >;
    counts.total = items.length;
    counts.invalid = 0;
    for (const item of items) {
      const row = object(item);
      const state = this.enumeration(row?.[field], choices);
      if (state === null) counts.invalid++;
      else counts[state]++;
    }
    return counts;
  }
  manifest(value: Json | undefined): DiagnosticManifest | null {
    if (value === undefined || value === null) return null;
    const row = object(value);
    if (!row) {
      this.audit.invalid_allowlisted_fields++;
      return null;
    }
    const entries = this.array(row.entries);
    return {
      schema: this.enumeration(row.schema, ["artifact-archive-1"]),
      request_id_sha256: this.identifier(row.requestId, "request"),
      run_id_sha256: this.identifier(row.runId, "run"),
      task_spec_sha256: this.hash(row.taskSpecHash),
      result_sha256: this.hash(row.resultSha256),
      synthetic: this.boolean(row.synthetic),
      completeness: this.enumeration(row.completeness, ["complete"]),
      entry_count: entries.length,
      entries: entries.map((entry) => {
        const item = object(entry);
        if (!item) this.audit.invalid_allowlisted_fields++;
        return {
          content_sha256: this.hash(item?.contentSha256),
          size_bytes: this.integer(item?.sizeBytes),
          artifact_id_sha256: this.identifier(item?.artifactId, "artifact"),
          complete: this.boolean(item?.complete),
        };
      }),
    };
  }
}

/** The userAction marker is an explicit call-site guard, NOT authentication or authorization.
 * CLI/UI callers must require an authenticated, deliberate local export action before calling.
 * No network, disk, telemetry or execution side effects occur here. Review bytes before sharing.
 */
export function exportSanitizedDiagnostics(
  input: DiagnosticInput,
  options: { userAction: "export_sanitized_diagnostics" },
): SanitizedDiagnosticExport {
  if (
    !options ||
    typeof options !== "object" ||
    types.isProxy(options) ||
    Object.getOwnPropertyDescriptor(options, "userAction")?.value !== "export_sanitized_diagnostics"
  )
    fail("diagnostic_action_required");
  const audit: DiagnosticAudit = {
    input_fields: 0,
    input_scalar_values: 0,
    scalar_values_used: 0,
    identifiers_hashed: 0,
    scalar_values_omitted: 0,
    invalid_allowlisted_fields: 0,
  };
  const source = object(boundedSnapshot(input, audit));
  const record = object(source?.record);
  const result = object(record?.result);
  if (!source || !record || !result) fail("diagnostic_input_invalid");
  const p = new Projection(audit);
  const synthetic = p.boolean(result.synthetic);
  const environment = object(source.environment);
  const content: SanitizedDiagnosticContent = {
    readme: README,
    disclosure: DIAGNOSTIC_DISCLOSURE,
    environment: {
      bridge_version: p.version(environment?.bridgeVersion),
      node_version: p.version(environment?.nodeVersion),
      platform: p.enumeration(environment?.platform, [
        "aix",
        "android",
        "darwin",
        "freebsd",
        "haiku",
        "linux",
        "openbsd",
        "sunos",
        "win32",
        "cygwin",
        "netbsd",
      ]),
      arch: p.enumeration(environment?.arch, [
        "arm",
        "arm64",
        "ia32",
        "loong64",
        "mips",
        "mipsel",
        "ppc",
        "ppc64",
        "riscv64",
        "s390",
        "s390x",
        "x64",
      ]),
    },
    stage_timeline: p.stages(source.stages),
    delivery_ack: p.ack(source.ack),
    known_errors: {
      task: p.errorCode(object(result.error)?.code),
      archive: p.errorCode(object(source.archiveVerification)?.issue),
    },
    expected_vs_actual: [],
    missing_data: [],
    task: {
      protocol_version: p.enumeration(result.protocol_version, ["2.0"]),
      request_id_sha256: p.identifier(result.request_id, "request"),
      run_id_sha256: p.identifier(result.run_id, "run"),
      task_spec_sha256: p.hash(result.task_spec_hash),
      task_file_sha256: p.hash(result.task_file_hash),
      status: p.enumeration(result.status, STATUSES),
      last_confirmed_status: p.enumeration(
        result.last_confirmed_status,
        STATUSES.filter((s) => s !== "unknown"),
      ),
      synthetic,
      observation_seq: p.integer(result.observation_seq),
      outcome_known: p.boolean(result.outcome_known),
      commands: p.histogram(result.commands_run, "termination", [
        "running",
        "exited",
        "killed",
        "unknown",
      ]),
      tests: p.histogram(result.tests, "outcome", ["passed", "failed", "skipped", "unknown"]),
      changed_files: p.histogram(result.changed_files, "change", ["added", "modified", "deleted"]),
      error_present: result.error !== undefined && result.error !== null,
    },
    manifest: p.manifest(source.manifest),
    verification: {
      source_result_state: p.enumeration(object(result.verification)?.state, [
        "pending",
        "verified",
        "rejected",
        "synthetic",
      ]),
      execution_kind:
        synthetic === true
          ? "synthetic"
          : synthetic === false
            ? "reported_non_synthetic_unverified"
            : "unknown",
      provider_run: "not_verified_by_export",
      archive: {
        reported_state:
          p.enumeration(object(source.archiveVerification)?.state, [
            "not_checked",
            "verified",
            "rejected",
          ]) ?? "not_checked",
        verified_by_export: false,
      },
    },
    redaction_audit: audit,
  };
  const compare = (a: string | null | undefined, b: string | null | undefined): string =>
    a === null || a === undefined || b === null || b === undefined
      ? "missing"
      : a === b
        ? "match"
        : "mismatch";
  content.expected_vs_actual = [
    {
      check: "terminal_result",
      expected: "cancelled_or_succeeded_or_failed",
      actual: content.task.status ?? "missing",
    },
    {
      check: "archive_integrity",
      expected: "verified_by_local_archive_inspection",
      actual: content.verification.archive.reported_state,
    },
    {
      check: "manifest_request_binding",
      expected: "matching_reported_identifiers",
      actual: compare(content.task.request_id_sha256, content.manifest?.request_id_sha256),
    },
    {
      check: "manifest_task_spec_binding",
      expected: "matching_reported_digests",
      actual: compare(content.task.task_spec_sha256, content.manifest?.task_spec_sha256),
    },
    {
      check: "persisted_result_ack",
      expected: "reported_result_ack",
      actual:
        content.delivery_ack.stage === "result_ack"
          ? "reported_result_ack"
          : content.delivery_ack.observation,
    },
    {
      check: "ack_payload_binding",
      expected: "matching_reported_digests",
      actual: compare(content.delivery_ack.payload_sha256, content.manifest?.result_sha256),
    },
    {
      check: "provider_execution",
      expected: "independent_provider_evidence",
      actual: content.verification.provider_run,
    },
  ];
  if (content.task.synthetic === null) content.missing_data.push("task.synthetic");
  if (content.task.status === null) content.missing_data.push("task.status");
  if (content.task.request_id_sha256 === null) content.missing_data.push("task.request_id_sha256");
  if (content.task.task_spec_sha256 === null) content.missing_data.push("task.task_spec_sha256");
  if (content.manifest === null) content.missing_data.push("manifest");
  for (const key of ["bridge_version", "node_version", "platform", "arch"] as const)
    if (content.environment[key] === null) content.missing_data.push(`environment.${key}`);
  if (content.stage_timeline.source !== "caller_reported")
    content.missing_data.push("stage_timeline");
  if (content.stage_timeline.events.some((event) => event.observed_at === null))
    content.missing_data.push("stage_timeline.observed_at");
  if (
    content.delivery_ack.observation === "not_provided" ||
    content.delivery_ack.observation === "invalid"
  )
    content.missing_data.push("delivery_ack");
  if (content.verification.archive.reported_state === "not_checked")
    content.missing_data.push("archive_verification");
  audit.scalar_values_omitted =
    audit.input_scalar_values - audit.scalar_values_used - audit.identifiers_hashed;
  const envelope: SanitizedDiagnosticEnvelope = {
    schema: "bridge-sanitized-diagnostics-1",
    content_sha256: digest(canonical(content)),
    content,
  };
  const bytes = Buffer.from(`${canonical(envelope)}\n`);
  return { bytes, sha256: digest(bytes), contentSha256: envelope.content_sha256, envelope };
}

/** Detached v2 diagnostic envelope preserves v1 readers and distinguishes hosted delivery. */
export interface RouteDiagnosticInput {
  local?: DiagnosticInput;
  hosted?: unknown;
  manifest?: unknown;
  archiveState?: unknown;
  materialization?: unknown;
}
export function exportRouteDiagnostics(
  input: RouteDiagnosticInput,
  options: { userAction: "export_sanitized_diagnostics" },
) {
  if (
    !options ||
    types.isProxy(options) ||
    Object.getOwnPropertyDescriptor(options, "userAction")?.value !== "export_sanitized_diagnostics"
  )
    fail("diagnostic_action_required");
  const audit: DiagnosticAudit = {
    input_fields: 0,
    input_scalar_values: 0,
    scalar_values_used: 0,
    identifiers_hashed: 0,
    scalar_values_omitted: 0,
    invalid_allowlisted_fields: 0,
  };
  const snapshot = object(boundedSnapshot(input, audit));
  if (!snapshot) fail("diagnostic_input_invalid");
  const p = new Projection(audit),
    hosted = object(snapshot.hosted),
    local = object(snapshot.local);
  if ((!hosted && !local) || (hosted && local)) fail("diagnostic_input_invalid");
  const manifest = object(snapshot.manifest),
    admission = object(manifest?.admission),
    pin = object(manifest?.pin),
    source = object(hosted?.source),
    identity = object(source?.identity),
    materialization = object(snapshot.materialization);
  const items = p.array(manifest?.items);
  const localReport = local
    ? exportSanitizedDiagnostics(local as unknown as DiagnosticInput, options).envelope.content
    : null;
  const content = {
    readme: `${README}\n\nRoute-specific interpretation: hosted completed is a captured browser reply, never local execution succeeded. Archive completeness and full requester materialization are separate caller-reported observations. A payload-only ACK does not establish full delivery. Unknown artifact enumeration must stay explicit.`,
    disclosure: DIAGNOSTIC_DISCLOSURE,
    route: hosted
      ? {
          kind: "hosted_delivery",
          request_id_sha256: p.identifier(hosted.requestId, "request"),
          task_spec_sha256: p.hash(hosted.taskSpecHash),
          attempt_id_sha256: p.identifier(hosted.attemptId, "attempt"),
          revision: p.integer(hosted.revision),
          status: p.enumeration(hosted.state, [
            "awaiting_approval",
            "approved",
            "unknown",
            "completed",
            "blocked_auth",
            "failed",
          ]),
          conversation_id_sha256: p.identifier(identity?.conversationId, "conversation"),
          user_turn_id_sha256: p.identifier(identity?.userTurnId, "user_turn"),
          assistant_turn_id_sha256: p.identifier(identity?.assistantTurnId, "assistant_turn"),
          frame_raw_sha256: p.hash(object(source?.frame)?.rawSha256),
          frame_body_sha256: p.hash(object(source?.frame)?.bodySha256),
          artifact_enumeration_known: p.boolean(object(hosted.inventory)?.enumerationKnown),
          payload_ack_observed: p.boolean(hosted.payloadAcknowledged),
          full_delivery_sufficient: p.boolean(hosted.fullDeliverySufficient),
          stage_timeline: p.stages(hosted.stages),
          runtime_version: p.version(hosted.bridgeVersion),
          platform: p.enumeration(hosted.platform, ["linux", "darwin", "win32"]),
          node_version: p.version(hosted.nodeVersion),
          execution_verified: false,
          source: "caller_reported",
        }
      : { kind: "local_execution", details: localReport },
    archive: {
      schema: p.enumeration(manifest?.schema, ["artifact-archive-2"]),
      state: p.enumeration(snapshot.archiveState, [
        "not_archived",
        "complete",
        "incomplete",
        "unavailable",
        "corrupt",
      ]),
      admission_sha256: p.hash(manifest?.admissionHash),
      registry_revision: p.integer(pin?.registryRevision),
      registry_snapshot_sha256: p.hash(pin?.registrySnapshotHash),
      request_id_sha256: p.identifier(admission?.requestId, "request"),
      task_spec_sha256: p.hash(admission?.taskSpecHash),
      required_set_known: p.boolean(manifest?.requiredSetKnown),
      complete: p.boolean(manifest?.complete),
      synthetic: p.boolean(manifest?.synthetic),
      items: items.map((item) => {
        const row = object(item);
        return {
          artifact_id_sha256: p.identifier(row?.artifactId, "artifact"),
          content_sha256: p.hash(row?.contentSha256),
          size_bytes: p.integer(row?.sizeBytes),
          required: p.boolean(row?.required),
          state: p.enumeration(row?.state, ["complete", "unavailable"]),
          unavailable_code: p.errorCode(row?.unavailableReason),
        };
      }),
    },
    materialization: {
      state: p.enumeration(materialization?.state, ["complete", "delivery_pending", "not_checked"]),
      receipt_sha256: p.hash(materialization?.receiptSha256),
      payload_verification: p.enumeration(materialization?.payloadVerification, [
        "local_result_and_receipt",
        "hosted_response_source",
      ]),
      synthetic: p.boolean(materialization?.synthetic),
      source: "caller_reported",
    },
    missing_data: [
      ...(!manifest ? ["archive_manifest_not_provided"] : []),
      ...(!materialization ? ["materialization_proof_not_provided"] : []),
      ...(hosted && !source ? ["hosted_source_provenance_not_provided"] : []),
    ],
    audit,
  };
  audit.scalar_values_omitted = Math.max(0, audit.input_scalar_values - audit.scalar_values_used);
  const envelope = {
    schema: "bridge-diagnostic-2",
    content_sha256: digest(canonical(content)),
    content,
  };
  const bytes = Buffer.from(`${canonical(envelope)}\n`);
  return { bytes, sha256: digest(bytes), contentSha256: envelope.content_sha256, envelope };
}
