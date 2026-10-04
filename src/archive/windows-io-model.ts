/** Executable fake contract model only: no native handles, IO, DB, SDK or activation. */
export interface ModelFacts {
  readonly volume: string;
  readonly id: string;
  readonly kind: "file" | "directory";
  readonly ownerHash: string;
  readonly daclHash: string;
  readonly links: number;
  readonly reparse: number;
  readonly deletePending: boolean;
  readonly attributes: number;
  readonly size: number | null;
  readonly path: string;
}
export interface ModelAnchor {
  readonly component: string;
  readonly facts: ModelFacts;
  readonly provenance: "independent" | "snapshot-copy" | "posix-pin";
  readonly record: symbol;
}
export interface ModelBound {
  readonly ref: symbol;
  readonly facts: ModelFacts;
  readonly observation: symbol;
  readonly created: boolean;
  readonly fileIndex?: number;
}
export interface ModelFile {
  readonly name: string;
  readonly bytes: readonly number[];
  readonly initialAttributes: number;
  readonly finalAttributes: number;
}
export interface ModelPlan {
  readonly mode: "fake-contract-model";
  readonly verb: "read-file" | "create-file" | "publish-directory" | "recover-scan";
  readonly anchors: readonly ModelAnchor[];
  readonly acquisitionPath: string;
  readonly files: readonly ModelFile[];
  readonly stage: string;
  readonly destination: string;
  readonly createdSecurity: { readonly ownerHash: string; readonly daclHash: string };
  readonly capabilities: {
    readonly relativeSingleComponent: boolean;
    readonly continuousChildren: boolean;
    readonly rootRelativeNoReplace: boolean;
    readonly fileAndDirectoryDurability: boolean;
    readonly id128: boolean;
  };
}
export type ModelPhase =
  | "acquire"
  | "C1"
  | "read"
  | "eof"
  | "C2-read"
  | "create-stage"
  | "create-file"
  | "write"
  | "readback"
  | "file-flush"
  | "C2-create"
  | "stage-directory-flush"
  | "rename"
  | "C3"
  | "published-content"
  | "destination-directory-flush"
  | "db-commit"
  | "scan"
  | "close"
  | "complete"
  | "failed"
  | "closed";
export interface ModelCommand {
  readonly modelOnly: true;
  readonly operation: symbol;
  readonly request: number;
  readonly kind: ModelPhase;
  readonly references: readonly symbol[];
  readonly target: symbol | null;
  readonly parent: symbol | null;
  readonly component: string | null;
  readonly offset: number;
  readonly length: number;
  readonly replaceIfExists: false;
  readonly sharing: "fixed-deny-write-delete";
}
export interface ModelReply {
  readonly operation: symbol;
  readonly error?: string;
  /** Explicit newly owned references, retained for close even on failed/late completion. */
  readonly bound?: readonly ModelBound[];
  readonly policy?: {
    readonly status: "candidate" | "rejected";
    readonly operation: symbol;
    readonly references: readonly symbol[];
  };
  readonly observations?: readonly { readonly ref: symbol; readonly facts: ModelFacts }[];
  readonly bytes?: readonly number[];
  readonly written?: number;
  readonly eof?: boolean;
  readonly done?: boolean;
  readonly contents?: readonly (readonly number[])[];
  readonly contentReferences?: readonly symbol[];
  readonly ioReference?: symbol;
  readonly closedReferences?: readonly symbol[];
  readonly recovery?: RecoveryEvidence;
}
export interface ModelState {
  readonly modelOnly: true;
  readonly windowsStorageEnabled: false;
  readonly operation: symbol;
  readonly plan: ModelPlan;
  readonly phase: ModelPhase;
  readonly pending: ModelCommand | null;
  readonly sequence: number;
  readonly bound: readonly ModelBound[];
  readonly fileIndex: number;
  readonly offset: number;
  readonly firstError: string | null;
  readonly timedOut: boolean;
  readonly cancellationRequested: boolean;
  readonly published: boolean;
  readonly dbCommitted: boolean;
  readonly ackCandidate: boolean;
  readonly recovery: RecoveryDecision | null;
  readonly cleanupError: "archive_io_cleanup_failed" | null;
}
export type ModelEvent =
  | { readonly type: "settled"; readonly request: number; readonly reply: ModelReply }
  | { readonly type: "timeout" }
  | { readonly type: "cancel-returned" }
  | { readonly type: "cleanup-failed" }
  | { readonly type: "close" };

const FILE_LIMIT = 16 * 1024 * 1024,
  TOTAL_LIMIT = 64 * 1024 * 1024,
  ENTRY_LIMIT = 128,
  ANCESTOR_LIMIT = 128;
// These checks validate fake data only. Symbols and labels cannot authenticate a real adapter.
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function arrayOf(v: unknown, check: (item: unknown) => boolean): v is readonly unknown[] {
  if (!Array.isArray(v)) return false;
  for (const item of v) if (!check(item)) return false;
  return true;
}
function factsShape(v: unknown): v is ModelFacts {
  return (
    record(v) &&
    ["volume", "id", "kind", "ownerHash", "daclHash", "path"].every(
      (key) => typeof v[key] === "string",
    ) &&
    ["links", "reparse", "attributes"].every((key) => typeof v[key] === "number") &&
    typeof v.deletePending === "boolean" &&
    (v.size === null || typeof v.size === "number")
  );
}
function symbols(v: unknown): v is readonly symbol[] {
  return arrayOf(v, (item) => typeof item === "symbol");
}
function numbers(v: unknown): v is readonly number[] {
  return arrayOf(v, (item) => typeof item === "number");
}
function observationsShape(v: unknown): v is NonNullable<ModelReply["observations"]> {
  return arrayOf(
    v,
    (item) => record(item) && typeof item.ref === "symbol" && factsShape(item.facts),
  );
}
function recoveryShape(v: unknown): v is RecoveryEvidence {
  return (
    record(v) &&
    typeof v.destination === "string" &&
    ["absent", "verified-content", "missing-file", "mismatch"].includes(v.destination) &&
    typeof v.staging === "string" &&
    ["none", "partial", "complete"].includes(v.staging) &&
    typeof v.destinationPath === "string" &&
    arrayOf(v.requiredFiles, (name) => typeof name === "string") &&
    ["dbCommitted", "fullChainIndependent", "fileAndDirectoryDurable"].every(
      (key) => typeof v[key] === "boolean",
    ) &&
    arrayOf(
      v.currentChain,
      (item) =>
        record(item) &&
        planAnchorShape(item.expected) &&
        record(item.observed) &&
        typeof item.observed.ref === "symbol" &&
        typeof item.observed.observation === "symbol" &&
        factsShape(item.observed.facts) &&
        item.observed.created === false,
    )
  );
}
function planAnchorShape(a: unknown): a is ModelAnchor {
  return (
    record(a) &&
    typeof a.component === "string" &&
    factsShape(a.facts) &&
    typeof a.provenance === "string" &&
    typeof a.record === "symbol"
  );
}
function planShape(v: unknown): v is ModelPlan {
  return (
    record(v) &&
    typeof v.mode === "string" &&
    typeof v.verb === "string" &&
    ["acquisitionPath", "stage", "destination"].every((key) => typeof v[key] === "string") &&
    arrayOf(v.anchors, planAnchorShape) &&
    arrayOf(
      v.files,
      (f) =>
        record(f) &&
        typeof f.name === "string" &&
        Array.isArray(f.bytes) &&
        typeof f.initialAttributes === "number" &&
        typeof f.finalAttributes === "number",
    ) &&
    record(v.createdSecurity) &&
    typeof v.createdSecurity.ownerHash === "string" &&
    typeof v.createdSecurity.daclHash === "string" &&
    record(v.capabilities) &&
    [
      "relativeSingleComponent",
      "continuousChildren",
      "rootRelativeNoReplace",
      "fileAndDirectoryDurability",
      "id128",
    ].every((key) => record(v.capabilities) && typeof v.capabilities[key] === "boolean")
  );
}
function replyShape(v: unknown): v is ModelReply {
  if (!record(v) || typeof v.operation !== "symbol") return false;
  return (
    (v.error === undefined || typeof v.error === "string") &&
    (v.bound === undefined ||
      arrayOf(
        v.bound,
        (b) =>
          record(b) &&
          typeof b.ref === "symbol" &&
          factsShape(b.facts) &&
          typeof b.observation === "symbol" &&
          typeof b.created === "boolean" &&
          (b.fileIndex === undefined || Number.isSafeInteger(b.fileIndex)),
      )) &&
    (v.policy === undefined ||
      (record(v.policy) &&
        typeof v.policy.status === "string" &&
        ["candidate", "rejected"].includes(v.policy.status) &&
        typeof v.policy.operation === "symbol" &&
        symbols(v.policy.references))) &&
    (v.observations === undefined || observationsShape(v.observations)) &&
    (v.bytes === undefined || numbers(v.bytes)) &&
    (v.written === undefined || typeof v.written === "number") &&
    ["done", "eof"].every((key) => v[key] === undefined || typeof v[key] === "boolean") &&
    (v.contents === undefined || arrayOf(v.contents, numbers)) &&
    (v.contentReferences === undefined || symbols(v.contentReferences)) &&
    (v.ioReference === undefined || typeof v.ioReference === "symbol") &&
    (v.closedReferences === undefined || symbols(v.closedReferences)) &&
    (v.recovery === undefined || recoveryShape(v.recovery))
  );
}
function eventShape(v: unknown): v is ModelEvent {
  return (
    record(v) &&
    typeof v.type === "string" &&
    (v.type === "settled"
      ? Number.isSafeInteger(v.request) && replyShape(v.reply)
      : ["timeout", "cancel-returned", "close", "cleanup-failed"].includes(v.type))
  );
}
export function beginWindowsIoModel(input: unknown): ModelState {
  if (planShape(input)) return beginValidatedPlan(input);
  const rejected = beginValidatedPlan({
    mode: "fake-contract-model",
    verb: "recover-scan",
    anchors: [],
    files: [],
    acquisitionPath: "",
    stage: "stage",
    destination: "destination",
    createdSecurity: { ownerHash: "", daclHash: "" },
    capabilities: {
      relativeSingleComponent: false,
      continuousChildren: false,
      rootRelativeNoReplace: false,
      fileAndDirectoryDurability: false,
      id128: false,
    },
  });
  return Object.freeze({ ...rejected, firstError: "archive_io_plan_invalid" });
}
const hex = (value: string, size: number) =>
  typeof value === "string" && value.length === size && /^[0-9a-f]+(?![\s\S])/.test(value);
function component(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 120 &&
    !/[\\/:<>"|?*~]/.test(value) &&
    !/[. ]$/.test(value) &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    !/^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(
      value,
    )
  );
}
const join = (parent: string, name: string) =>
  `${parent}${parent.endsWith("\\") ? "" : "\\"}${name}`;
function validFacts(f: ModelFacts): string | null {
  if (
    !f ||
    !hex(f.volume, 16) ||
    !hex(f.id, 32) ||
    /^0+$/.test(f.id) ||
    !hex(f.ownerHash, 64) ||
    !hex(f.daclHash, 64)
  )
    return "archive_io_metadata_unknown";
  if (f.reparse !== 0) return "archive_io_reparse";
  if (f.links !== 1) return "archive_io_links";
  if (
    f.deletePending !== false ||
    !Number.isInteger(f.attributes) ||
    f.attributes <= 0 ||
    f.attributes > 0xffffffff ||
    (f.attributes & ~0x21b7) !== 0 ||
    ((f.attributes & 0x80) !== 0 && f.attributes !== 0x80)
  )
    return "archive_io_metadata_changed";
  if (f.kind !== "file" && f.kind !== "directory") return "archive_io_metadata_unknown";
  if ((f.attributes & 0x10) !== (f.kind === "directory" ? 0x10 : 0))
    return "archive_io_metadata_changed";
  if (
    f.kind === "file" &&
    (!Number.isSafeInteger(f.size) || (f.size as number) < 0 || (f.size as number) > FILE_LIMIT)
  )
    return "archive_size_limit";
  if (f.kind === "directory" && f.size !== null) return "archive_io_metadata_unknown";
  return typeof f.path === "string" && f.path.length > 0 ? null : "archive_io_metadata_unknown";
}
function stable(a: ModelFacts, b: ModelFacts): string | null {
  const invalid = validFacts(b);
  if (invalid) return invalid;
  if (a.volume !== b.volume || a.id !== b.id || a.kind !== b.kind)
    return "archive_io_identity_changed";
  if (a.ownerHash !== b.ownerHash || a.daclHash !== b.daclHash || a.links !== b.links)
    return "archive_io_metadata_changed";
  return null;
}
function fail(s: ModelState, error: string): ModelState {
  return Object.freeze({
    ...s,
    phase: "failed",
    firstError: s.firstError ?? error,
    ackCandidate: false,
  });
}
function issue(s: ModelState, phase: ModelPhase): ModelState {
  const current = s.plan.files[s.fileIndex],
    parent = s.bound[s.plan.anchors.length - 1]?.ref ?? null;
  const stage = s.bound.find((b) => b.created && b.facts.kind === "directory");
  const file = s.bound.find((b) => b.fileIndex === s.fileIndex);
  const pending: ModelCommand = Object.freeze({
    modelOnly: true,
    operation: s.operation,
    request: s.sequence + 1,
    kind: phase,
    references: Object.freeze(s.bound.map((b) => b.ref)),
    target: ["read", "eof", "destination-directory-flush"].includes(phase)
      ? parent
      : ["rename", "stage-directory-flush"].includes(phase)
        ? (stage?.ref ?? null)
        : (file?.ref ?? null),
    parent:
      phase === "create-file"
        ? (stage?.ref ?? parent)
        : (s.bound[s.plan.anchors.length - 1]?.ref ?? null),
    component:
      phase === "create-stage"
        ? s.plan.stage
        : phase === "create-file"
          ? (current?.name ?? null)
          : phase === "rename"
            ? s.plan.destination
            : null,
    offset: s.offset,
    length: (current?.bytes.length ?? 0) - s.offset,
    replaceIfExists: false,
    sharing: "fixed-deny-write-delete",
  });
  // File operations identify the exact reference rather than any pathname.
  if (["write", "readback", "file-flush"].includes(phase) && !file)
    return fail(s, "archive_io_binding_lost");
  return Object.freeze({ ...s, phase, pending, sequence: pending.request, ackCandidate: false });
}
function finish(s: ModelState): ModelState {
  return Object.freeze({
    ...s,
    phase: "complete",
    pending: null,
    ackCandidate: s.plan.verb === "publish-directory" && s.dbCommitted,
  });
}
function beginValidatedPlan(plan: ModelPlan): ModelState {
  // Deep-copy all data so later caller mutation cannot change the issued contract.
  const oversize =
    plan.files.length > ENTRY_LIMIT ||
    plan.files.some((f) => f.bytes.length > FILE_LIMIT) ||
    plan.files.reduce((n, f) => n + f.bytes.length, 0) > TOTAL_LIMIT;
  const copy = Object.freeze({
    ...plan,
    anchors: Object.freeze(
      plan.anchors
        .slice(0, ANCESTOR_LIMIT + 1)
        .map((a) => Object.freeze({ ...a, facts: Object.freeze({ ...a.facts }) })),
    ),
    files: Object.freeze(
      oversize
        ? []
        : plan.files.map((f) => Object.freeze({ ...f, bytes: Object.freeze([...f.bytes]) })),
    ),
    createdSecurity: Object.freeze({ ...plan.createdSecurity }),
    capabilities: Object.freeze({ ...plan.capabilities }),
  });
  let s: ModelState = Object.freeze({
    modelOnly: true,
    windowsStorageEnabled: false,
    operation: Symbol("fake-operation"),
    plan: copy,
    phase: "acquire",
    pending: null,
    sequence: 0,
    bound: Object.freeze([]),
    fileIndex: 0,
    offset: 0,
    firstError: null,
    timedOut: false,
    cancellationRequested: false,
    published: false,
    dbCommitted: false,
    ackCandidate: false,
    recovery: null,
    cleanupError: null,
  });
  if (
    copy.mode !== "fake-contract-model" ||
    !["read-file", "create-file", "publish-directory", "recover-scan"].includes(copy.verb)
  )
    return fail(s, "archive_io_model_only");
  if (oversize) return fail(s, "archive_size_limit");
  if (
    !copy.anchors.length ||
    copy.anchors.length > ANCESTOR_LIMIT ||
    copy.anchors.some((a) => a.provenance !== "independent" || typeof a.record !== "symbol")
  )
    return fail(s, "archive_io_trust_missing");
  if (copy.anchors.at(-1)?.facts.path !== copy.acquisitionPath)
    return fail(s, "archive_io_trust_missing");
  if (copy.anchors[0]?.facts.kind !== "directory") return fail(s, "archive_io_metadata_changed");
  if (copy.verb !== "read-file" && copy.anchors.at(-1)?.facts.kind !== "directory")
    return fail(s, "archive_io_metadata_changed");
  if (copy.capabilities.relativeSingleComponent !== true || copy.capabilities.id128 !== true)
    return fail(s, "archive_io_unsupported_filesystem");
  if (
    copy.verb === "publish-directory" &&
    (copy.capabilities.continuousChildren !== true ||
      copy.capabilities.rootRelativeNoReplace !== true ||
      copy.capabilities.fileAndDirectoryDurability !== true)
  )
    return fail(s, "archive_io_publication_unsupported");
  if (
    !component(copy.stage) ||
    !component(copy.destination) ||
    copy.stage.toLowerCase() === copy.destination.toLowerCase()
  )
    return fail(s, "archive_io_path_invalid");
  for (const [i, a] of copy.anchors.entries()) {
    const error = validFacts(a.facts);
    if (error) return fail(s, error);
    if (i === 0 && a.facts.path !== a.component) return fail(s, "archive_io_path_invalid");
    if ((i === 0 && !/^[A-Z]:\\(?![\s\S])/.test(a.component)) || (i > 0 && !component(a.component)))
      return fail(s, "archive_io_path_invalid");
    if (
      i &&
      a.facts.path !== `${copy.anchors[i - 1]?.facts.path}${i === 1 ? "" : "\\"}${a.component}`
    )
      return fail(s, "archive_io_path_invalid");
    if (
      a.facts.volume !== copy.anchors[0]?.facts.volume ||
      (i < copy.anchors.length - 1 && a.facts.kind !== "directory")
    )
      return fail(s, "archive_io_identity_changed");
  }
  if (
    copy.files.length > ENTRY_LIMIT ||
    copy.files.some(
      (f) =>
        !component(f.name) ||
        f.bytes.length > FILE_LIMIT ||
        f.bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255),
    ) ||
    copy.files.reduce((n, f) => n + f.bytes.length, 0) > TOTAL_LIMIT
  )
    return fail(s, "archive_size_limit");
  if (new Set(copy.files.map((f) => f.name.toLowerCase())).size !== copy.files.length)
    return fail(s, "archive_filename_collision");
  if (copy.verb !== "recover-scan" && !copy.files.length) return fail(s, "archive_size_limit");
  if (copy.verb === "create-file" && copy.files.length !== 1)
    return fail(s, "archive_io_plan_invalid");
  if (
    new Set(copy.anchors.map((a) => a.record)).size !== copy.anchors.length ||
    new Set(copy.anchors.map((a) => a.facts.id)).size !== copy.anchors.length
  )
    return fail(s, "archive_io_trust_missing");
  if (
    copy.verb === "read-file" &&
    (copy.files.length !== 1 ||
      copy.anchors.at(-1)?.facts.kind !== "file" ||
      copy.anchors.at(-1)?.facts.size !== copy.files[0]?.bytes.length)
  )
    return fail(s, "archive_io_metadata_changed");
  s = issue(s, "acquire");
  return s;
}
function policyMatches(s: ModelState, reply: ModelReply, refs: readonly symbol[]): boolean {
  return (
    reply.policy?.status === "candidate" &&
    reply.policy.operation === s.operation &&
    reply.policy.references.length === refs.length &&
    refs.every((ref, i) => reply.policy?.references[i] === ref)
  );
}
function checkpoint(
  s: ModelState,
  reply: ModelReply,
  final: boolean,
  renamed: boolean,
): string | null {
  if (reply.observations?.length !== s.bound.length) return "archive_io_binding_lost";
  if (
    !policyMatches(
      s,
      reply,
      s.bound.map((b) => b.ref),
    )
  )
    return "archive_io_stale_policy";
  const parentPath = s.plan.anchors.at(-1)?.facts.path ?? "";
  for (const [i, bound] of s.bound.entries()) {
    const observation = reply.observations[i];
    if (observation?.ref !== bound.ref) return "archive_io_binding_lost";
    const error = stable(bound.facts, observation.facts);
    if (error) return error;
    const file = bound.fileIndex === undefined ? undefined : s.plan.files[bound.fileIndex];
    const expectedSize = file && final ? file.bytes.length : bound.facts.size;
    const expectedAttributes = file && final ? file.finalAttributes : bound.facts.attributes;
    const expectedPath =
      renamed && bound.created
        ? bound.facts.path.replace(
            join(parentPath, s.plan.stage),
            join(parentPath, s.plan.destination),
          )
        : bound.facts.path;
    if (
      observation.facts.size !== expectedSize ||
      observation.facts.attributes !== expectedAttributes ||
      observation.facts.path !== expectedPath
    )
      return renamed ? "archive_io_post_publish_mismatch" : "archive_io_metadata_changed";
  }
  return null;
}
export function advanceWindowsIoModel(s: ModelState, input: unknown): ModelState {
  if (!eventShape(input)) return fail(s, "archive_io_event_invalid");
  const event = input;
  if (event.type === "cleanup-failed")
    return s.pending || !s.firstError || s.phase === "closed"
      ? s
      : Object.freeze({ ...s, cleanupError: "archive_io_cleanup_failed" });
  if (event.type === "timeout")
    return s.pending
      ? Object.freeze({
          ...s,
          firstError: s.firstError ?? "archive_io_timeout",
          timedOut: true,
          cancellationRequested: true,
          ackCandidate: false,
        })
      : fail(s, "archive_io_timeout");
  // Cancellation intent stops forward progress, but its return never drains pending IO.
  if (event.type === "cancel-returned")
    return s.cancellationRequested
      ? s
      : Object.freeze({
          ...s,
          firstError: s.firstError ?? "archive_io_cancelled",
          cancellationRequested: true,
          ackCandidate: false,
        });
  if (event.type === "close") return s.pending ? s : s.phase === "closed" ? s : issue(s, "close");
  if (!s.pending || event.request !== s.pending.request || event.reply.operation !== s.operation)
    return Object.freeze({
      ...s,
      firstError: s.firstError ?? "archive_io_completion_unmatched",
      ackCandidate: false,
    });
  const phase = s.pending.kind,
    reply = event.reply;
  // Remember owned late-acquisition references before abort finalization; never forget
  // handles simply because an application deadline expired during acquire/create/scan. Recovery evidence alone never conveys ownership.
  const received = reply.bound ?? [];
  let next: ModelState = Object.freeze({
    ...s,
    pending: null,
    bound: Object.freeze(
      [
        ...s.bound,
        ...received
          .filter(
            (b, i) =>
              !s.bound.some((old) => old.ref === b.ref) &&
              !received.slice(0, i).some((old) => old.ref === b.ref),
          )
          .map((b) => ({ ...b, created: false })),
      ].map((b) => Object.freeze({ ...b, facts: Object.freeze({ ...b.facts }) })),
    ),
    published: s.published || (phase === "rename" && reply.done === true),
    dbCommitted: s.dbCommitted || (phase === "db-commit" && reply.done === true),
  });
  if (phase === "close")
    return reply.error === undefined &&
      received.length === 0 &&
      reply.done === true &&
      reply.closedReferences?.length === s.bound.length &&
      s.bound.every((b, i) => reply.closedReferences?.[i] === b.ref)
      ? Object.freeze({ ...next, phase: "closed", bound: Object.freeze([]), ackCandidate: false })
      : fail(next, "archive_io_close_failed");
  if (s.firstError) return fail(next, s.firstError);
  if (received.length && !["acquire", "create-stage", "create-file", "scan"].includes(phase))
    return fail(next, "archive_io_binding_lost");
  if (reply.error)
    return fail(
      next,
      [
        "archive_io_busy",
        "archive_io_exists",
        "archive_io_publish_conflict",
        "archive_io_flush_failed",
        "archive_io_directory_flush_failed",
        "archive_io_denied",
        "archive_io_cancelled",
        "archive_io_unsupported_filesystem",
      ].includes(reply.error)
        ? reply.error
        : "archive_io_adapter_error",
    );
  if (
    [
      "read",
      "eof",
      "write",
      "readback",
      "file-flush",
      "rename",
      "stage-directory-flush",
      "destination-directory-flush",
    ].includes(phase) &&
    reply.ioReference !== s.pending.target
  )
    return fail(next, "archive_io_binding_lost");
  switch (phase) {
    case "acquire": {
      if (
        received.length !== s.plan.anchors.length ||
        new Set(received.map((b) => b.ref)).size !== received.length
      )
        return fail(next, "archive_io_binding_lost");
      if (
        !policyMatches(
          s,
          reply,
          received.map((b) => b.ref),
        )
      )
        return fail(next, "archive_io_stale_policy");
      for (const [i, b] of received.entries()) {
        const a = s.plan.anchors[i];
        if (
          !a ||
          b.created ||
          b.fileIndex !== undefined ||
          s.plan.anchors.some((anchor) => anchor.record === b.observation)
        )
          return fail(next, "archive_io_trust_missing");
        const error = stable(a.facts, b.facts);
        if (error) return fail(next, error);
        if (
          a.facts.path !== b.facts.path ||
          a.facts.size !== b.facts.size ||
          a.facts.attributes !== b.facts.attributes
        )
          return fail(next, "archive_io_metadata_changed");
      }
      return issue(next, "C1");
    }
    case "C1": {
      const error = checkpoint(next, reply, false, false);
      if (error) return fail(next, error);
      return issue(
        next,
        s.plan.verb === "read-file"
          ? s.plan.files[0]?.bytes.length
            ? "read"
            : "eof"
          : s.plan.verb === "recover-scan"
            ? "scan"
            : s.plan.verb === "publish-directory"
              ? "create-stage"
              : "create-file",
      );
    }
    case "create-stage":
    case "create-file": {
      const b = received[0],
        directory = phase === "create-stage",
        f = s.plan.files[s.fileIndex],
        anchorParent = s.plan.anchors.at(-1)?.facts.path;
      if (!anchorParent || (!directory && !f)) return fail(next, "archive_io_plan_invalid");
      if (
        !b ||
        received.length !== 1 ||
        !b.created ||
        (directory && b.fileIndex !== undefined) ||
        s.bound.some((old) => old.ref === b.ref || old.facts.id === b.facts.id) ||
        b.facts.volume !== s.plan.anchors[0]?.facts.volume
      )
        return fail(next, "archive_io_binding_lost");
      const error = validFacts(b.facts);
      if (error) return fail(next, error);
      if (
        !policyMatches(
          s,
          reply,
          next.bound.map((item) => item.ref),
        ) ||
        b.facts.ownerHash !== s.plan.createdSecurity.ownerHash ||
        b.facts.daclHash !== s.plan.createdSecurity.daclHash
      )
        return fail(next, "archive_io_stale_policy");
      const parent = directory
        ? anchorParent
        : s.plan.verb === "publish-directory"
          ? join(anchorParent, s.plan.stage)
          : anchorParent;
      if (
        b.facts.kind !== (directory ? "directory" : "file") ||
        b.facts.size !== (directory ? null : 0) ||
        b.facts.path !== join(parent, directory ? s.plan.stage : (f?.name ?? "")) ||
        (!directory && (b.fileIndex !== s.fileIndex || b.facts.attributes !== f?.initialAttributes))
      )
        return fail(next, "archive_io_metadata_changed");
      next = Object.freeze({
        ...next,
        bound: Object.freeze(
          next.bound.map((item) =>
            item.ref === b.ref ? Object.freeze({ ...item, created: true }) : item,
          ),
        ),
      });
      return issue(next, directory ? "create-file" : f?.bytes.length ? "write" : "readback");
    }
    case "write": {
      const file = s.plan.files[s.fileIndex];
      if (!file) return fail(next, "archive_io_plan_invalid");
      const remaining = file.bytes.length - s.offset;
      if (
        !Number.isInteger(reply.written) ||
        (reply.written ?? 0) <= 0 ||
        (reply.written ?? 0) > remaining
      )
        return fail(next, "archive_io_write_progress");
      next = Object.freeze({ ...next, offset: s.offset + (reply.written as number) });
      return issue(next, next.offset < file.bytes.length ? "write" : "readback");
    }
    case "read": {
      const expected = s.plan.files[0]?.bytes;
      if (!expected) return fail(next, "archive_io_plan_invalid");
      if (
        !reply.bytes?.length ||
        reply.bytes.length > expected.length - s.offset ||
        reply.bytes.some((b, i) => b !== expected[s.offset + i])
      )
        return fail(next, "archive_io_read_mismatch");
      next = Object.freeze({ ...next, offset: s.offset + reply.bytes.length });
      return issue(next, next.offset === expected.length ? "eof" : "read");
    }
    case "eof":
      return reply.eof === true ? issue(next, "C2-read") : fail(next, "archive_io_read_mismatch");
    case "C2-read": {
      const error = checkpoint(next, reply, false, false);
      return error ? fail(next, error) : finish(next);
    }
    case "readback": {
      const expected = s.plan.files[s.fileIndex]?.bytes;
      if (!expected) return fail(next, "archive_io_plan_invalid");
      if (reply.bytes?.length !== expected.length || reply.bytes.some((b, i) => b !== expected[i]))
        return fail(next, "archive_io_read_mismatch");
      return issue(next, "file-flush");
    }
    case "file-flush":
      return reply.done === true ? issue(next, "C2-create") : fail(next, "archive_io_flush_failed");
    case "C2-create": {
      const error = checkpoint(next, reply, true, false);
      if (error) return fail(next, error);
      if (s.plan.verb === "create-file") return finish(next);
      if (s.fileIndex + 1 < s.plan.files.length)
        return issue(
          Object.freeze({ ...next, fileIndex: s.fileIndex + 1, offset: 0 }),
          "create-file",
        );
      return issue(next, "stage-directory-flush");
    }
    case "stage-directory-flush":
      return reply.done === true
        ? issue(next, "rename")
        : fail(next, "archive_io_directory_flush_failed");
    case "rename":
      return reply.done === true
        ? issue(Object.freeze({ ...next, published: true }), "C3")
        : fail(next, "archive_io_publish_conflict");
    case "C3": {
      const error = checkpoint(next, reply, true, true);
      return error
        ? fail(next, "archive_io_post_publish_mismatch")
        : issue(next, "published-content");
    }
    case "published-content": {
      if (
        reply.contents?.length !== s.plan.files.length ||
        reply.contentReferences?.length !== s.plan.files.length ||
        s.plan.files.some(
          (_, i) =>
            reply.contentReferences?.[i] !==
            s.bound.find((b) => b.created && b.fileIndex === i)?.ref,
        ) ||
        reply.contents.some(
          (bytes, i) =>
            bytes.length !== s.plan.files[i]?.bytes.length ||
            bytes.some((b, j) => b !== s.plan.files[i]?.bytes[j]),
        )
      )
        return fail(next, "archive_io_post_publish_mismatch");
      return issue(next, "destination-directory-flush");
    }
    case "destination-directory-flush":
      return reply.done === true
        ? issue(next, "db-commit")
        : fail(next, "archive_io_directory_flush_failed");
    case "db-commit":
      return reply.done === true
        ? finish(Object.freeze({ ...next, dbCommitted: true }))
        : fail(next, "archive_io_db_commit_failed");
    case "scan": {
      const matches = recoveryMatchesScan(s, reply);
      next = Object.freeze({
        ...next,
        recovery: classifyWindowsRecoveryModel(matches ? reply.recovery : null),
      });
      return matches ? finish(next) : fail(next, "archive_io_scan_invalid");
    }
    default:
      return fail(next, "archive_io_transition_invalid");
  }
}

// Bind current-content evidence to this symbolic scan, not to a previous process identity.
function recoveryMatchesScan(s: ModelState, reply: ModelReply): boolean {
  const e = reply.recovery;
  const acquired = reply.bound ?? [];
  if (
    !e ||
    e.destinationPath !== join(s.plan.acquisitionPath, s.plan.destination) ||
    e.requiredFiles.length !== s.plan.files.length ||
    s.plan.files.some((file, i) => e.requiredFiles[i] !== file.name) ||
    !policyMatches(
      s,
      reply,
      e.currentChain.map((item) => item.observed.ref),
    ) ||
    e.currentChain.length !== s.bound.length + acquired.length ||
    new Set(acquired.map((b) => b.ref)).size !== acquired.length ||
    acquired.some((b, i) => {
      const observed = e.currentChain[s.bound.length + i]?.observed;
      return (
        !observed ||
        b.created ||
        b.fileIndex !== undefined ||
        s.bound.some((old) => old.ref === b.ref) ||
        b.ref !== observed.ref ||
        b.observation !== observed.observation ||
        !!stable(b.facts, observed.facts) ||
        b.facts.path !== observed.facts.path ||
        b.facts.size !== observed.facts.size ||
        b.facts.attributes !== observed.facts.attributes
      );
    }) ||
    (e.destination === "verified-content" &&
      (e.currentChain.length !== s.bound.length + 1 + s.plan.files.length ||
        e.currentChain[s.bound.length]?.expected.facts.kind !== "directory" ||
        e.currentChain[s.bound.length]?.expected.facts.path !== e.destinationPath))
  )
    return false;
  return s.plan.anchors.every((anchor, i) => {
    const item = e.currentChain[i],
      retained = s.bound[i];
    return (
      !!item &&
      !!retained &&
      item.expected.record === anchor.record &&
      item.expected.component === anchor.component &&
      item.expected.provenance === anchor.provenance &&
      !stable(anchor.facts, item.expected.facts) &&
      item.expected.facts.path === anchor.facts.path &&
      item.expected.facts.size === anchor.facts.size &&
      item.expected.facts.attributes === anchor.facts.attributes &&
      item.observed.ref === retained.ref &&
      !stable(retained.facts, item.observed.facts) &&
      item.observed.facts.path === retained.facts.path &&
      item.observed.facts.size === retained.facts.size &&
      item.observed.facts.attributes === retained.facts.attributes
    );
  });
}

export interface RecoveryEvidence {
  readonly destination: "absent" | "verified-content" | "missing-file" | "mismatch";
  readonly staging: "none" | "partial" | "complete";
  readonly dbCommitted: boolean;
  readonly fullChainIndependent: boolean;
  readonly fileAndDirectoryDurable: boolean;
  readonly destinationPath: string;
  readonly requiredFiles: readonly string[];
  readonly currentChain: readonly {
    readonly expected: ModelAnchor;
    readonly observed: ModelBound;
  }[];
}
export interface RecoveryDecision {
  readonly modelOnly: true;
  readonly windowsStorageEnabled: false;
  readonly status: "incomplete" | "content-candidate";
  readonly preserveStaging: true;
  readonly wouldCommitDb: boolean;
  readonly ackCandidate: boolean;
  readonly detectsPreviousSameBytesIdentityReplacement: false;
}
export function classifyWindowsRecoveryModel(input: unknown): RecoveryDecision {
  const e = recoveryShape(input) ? input : null;
  const verified =
    e?.destination === "verified-content" &&
    e.fullChainIndependent === true &&
    e.fileAndDirectoryDurable === true &&
    completeRecoveryFiles(e) &&
    independentRecoveryChain(e.currentChain);
  return Object.freeze({
    modelOnly: true,
    windowsStorageEnabled: false,
    status: verified ? "content-candidate" : "incomplete",
    preserveStaging: true,
    wouldCommitDb: verified && e?.dbCommitted === false,
    ackCandidate: verified && e?.dbCommitted === true,
    detectsPreviousSameBytesIdentityReplacement: false,
  });
}
function completeRecoveryFiles(e: RecoveryEvidence): boolean {
  if (
    !e.requiredFiles.length ||
    e.requiredFiles.length > ENTRY_LIMIT ||
    !e.requiredFiles.every(component) ||
    new Set(e.requiredFiles.map((name) => name.toLowerCase())).size !== e.requiredFiles.length
  )
    return false;
  const paths = e.currentChain.map((item) => item.expected.facts.path);
  return (
    new Set(paths).size === paths.length &&
    e.currentChain.some(
      (item) =>
        item.expected.facts.kind === "directory" && item.expected.facts.path === e.destinationPath,
    ) &&
    e.currentChain.filter((item) => item.expected.facts.kind === "file").length ===
      e.requiredFiles.length &&
    e.requiredFiles.every((name) =>
      e.currentChain.some(
        (item) =>
          item.expected.facts.kind === "file" &&
          item.expected.facts.path === join(e.destinationPath, name),
      ),
    )
  );
}
function independentRecoveryChain(chain: RecoveryEvidence["currentChain"]): boolean {
  // Publication retains up to ANCESTOR_LIMIT ancestors, one destination, and ENTRY_LIMIT files.
  if (
    !chain.length ||
    chain.length > ANCESTOR_LIMIT + 1 + ENTRY_LIMIT ||
    chain.filter((item) => item.expected.facts.kind === "directory").length > ANCESTOR_LIMIT + 1 ||
    chain.filter((item) => item.expected.facts.kind === "file").length > ENTRY_LIMIT
  )
    return false;
  const records = chain.map((item) => item.expected.record);
  if (
    new Set(records).size !== chain.length ||
    new Set(chain.map((item) => item.observed.ref)).size !== chain.length ||
    new Set(chain.map((item) => item.expected.facts.id)).size !== chain.length
  )
    return false;
  return chain.every(({ expected: a, observed: b }, i) => {
    if (
      a.provenance !== "independent" ||
      records.includes(b.observation) ||
      validFacts(a.facts) ||
      stable(a.facts, b.facts) ||
      a.facts.path !== b.facts.path ||
      a.facts.size !== b.facts.size ||
      a.facts.attributes !== b.facts.attributes ||
      a.facts.volume !== chain[0]?.expected.facts.volume
    )
      return false;
    if (i === 0)
      return (
        a.facts.kind === "directory" &&
        a.facts.path === a.component &&
        /^[A-Z]:\\(?![\s\S])/.test(a.component)
      );
    return (
      component(a.component) &&
      chain
        .slice(0, i)
        .some(
          (parent) =>
            parent.expected.facts.kind === "directory" &&
            join(parent.expected.facts.path, a.component) === a.facts.path,
        )
    );
  });
}
/** Cleanup is a pure candidate list, never a delete/close operation. */
export function planWindowsModelCleanup(
  s: ModelState,
  observations: unknown,
  unknownEntries: unknown,
): readonly symbol[] {
  if (
    s.pending ||
    s.published ||
    !s.firstError ||
    unknownEntries !== false ||
    !observationsShape(observations) ||
    observations.length !== s.bound.length
  )
    return Object.freeze([]);
  for (const [i, b] of s.bound.entries()) {
    const observed = observations[i];
    if (
      !observed ||
      observed.ref !== b.ref ||
      stable(b.facts, observed.facts) ||
      observed.facts.path !== b.facts.path ||
      (observed.facts.attributes !== b.facts.attributes &&
        !(
          b.created &&
          b.fileIndex !== undefined &&
          observed.facts.attributes === s.plan.files[b.fileIndex]?.finalAttributes
        )) ||
      observed.facts.size !==
        (b.created && b.fileIndex !== undefined
          ? b.fileIndex === s.fileIndex
            ? s.offset
            : s.plan.files[b.fileIndex]?.bytes.length
          : b.facts.size)
    )
      return Object.freeze([]);
  }
  return Object.freeze(
    s.bound
      .filter((b) => b.created)
      .map((b) => b.ref)
      .reverse(),
  );
}
