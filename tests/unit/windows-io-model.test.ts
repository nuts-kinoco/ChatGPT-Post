import { describe, expect, it } from "vitest";
import {
  advanceWindowsIoModel,
  beginWindowsIoModel,
  classifyWindowsRecoveryModel,
  type ModelFacts,
  planWindowsModelCleanup,
} from "../../src/archive/windows-io-model.js";
import { observations, plan, recovery, WindowsIoFake } from "../helpers/windows-io-fake.js";

describe("Windows IO fake contract (never enables storage)", () => {
  it("rejects sparse anchors and event type coercion without throwing", () => {
    expect(beginWindowsIoModel({ ...plan(), anchors: new Array(2) }).firstError).toBe(
      "archive_io_plan_invalid",
    );
    const s = beginWindowsIoModel(plan());
    expect(advanceWindowsIoModel(s, { type: { toString: () => "close" } }).firstError).toBe(
      "archive_io_event_invalid",
    );
  });
  it("refuses sparse byte replies and retains unsolicited close references", () => {
    const fake = new WindowsIoFake();
    const s = fake.until(beginWindowsIoModel(plan()), "readback");
    const sparse = fake.step(s, (r) => ({ ...r, bytes: new Array(3) }));
    expect(sparse.firstError).toBe("archive_io_event_invalid");
    expect(sparse.pending).toBe(s.pending);
    const finished = fake.until(s);
    const closing = advanceWindowsIoModel(finished, { type: "close" });
    const extra = finished.bound[0];
    if (!extra) throw new Error("fixture missing bound");
    const rejected = fake.step(closing, (r) => ({
      ...r,
      bound: [{ ...extra, ref: Symbol("extra") }],
    }));
    expect(rejected.phase).toBe("failed");
    expect(rejected.firstError).toBe("archive_io_close_failed");
    expect(rejected.bound.length).toBe(finished.bound.length + 1);
  });
  it.each(["read-file", "create-file", "publish-directory", "recover-scan"] as const)(
    "runs %s with symbolic effects only",
    (verb) => {
      const fake = new WindowsIoFake();
      const result = fake.until(beginWindowsIoModel(plan(verb)));
      expect(result.phase).toBe("complete");
      expect(result.firstError).toBeNull();
      expect(result.windowsStorageEnabled).toBe(false);
      expect(result.modelOnly).toBe(true);
      expect(result.ackCandidate).toBe(verb === "publish-directory");
      const closed = fake.step(advanceWindowsIoModel(result, { type: "close" }));
      expect(closed.phase).toBe("closed");
      expect(closed.bound).toEqual([]);
      expect(advanceWindowsIoModel(closed, { type: "close" })).toBe(closed);
    },
  );
  it("keeps all children and parents through multi-file rename, planned size and path changes", () => {
    const p = plan();
    const fake = new WindowsIoFake();
    const s = fake.until(
      beginWindowsIoModel({
        ...p,
        files: [...p.files, { ...p.files[0], name: "empty.txt", bytes: [] }],
      }),
    );
    expect(s.ackCandidate).toBe(true);
    const creates = fake.commands.filter((c) => c.kind === "create-file");
    const stage = s.bound.find((b) => b.created && b.facts.kind === "directory");
    expect(creates.map((c) => c.parent)).toEqual([stage?.ref, stage?.ref]);
    const rename = fake.commands.find((c) => c.kind === "rename");
    expect(rename?.target).toBe(stage?.ref);
    expect(rename?.parent).toBe(s.bound[1]?.ref);
    expect(rename?.replaceIfExists).toBe(false);
    expect(rename?.references).toHaveLength(5);
    expect(fake.commands.map((c) => c.kind).slice(-7)).toEqual([
      "C2-create",
      "stage-directory-flush",
      "rename",
      "C3",
      "published-content",
      "destination-directory-flush",
      "db-commit",
    ]);
  });
  it("deep copies the plan and completion facts", () => {
    const p = plan();
    const s = beginWindowsIoModel(p);
    expect(s.plan).not.toBe(p);
    expect(s.plan.files[0]?.bytes).not.toBe(p.files[0]?.bytes);
    expect(Object.isFrozen(s.plan.anchors[0]?.facts)).toBe(true);
    const fake = new WindowsIoFake();
    const reply = fake.reply(s);
    const next = advanceWindowsIoModel(s, { type: "settled", request: s.pending?.request, reply });
    expect(next.bound[0]?.facts).not.toBe(reply.bound?.[0]?.facts);
    expect(Object.isFrozen(next.bound[0]?.facts)).toBe(true);
  });
  it.each([null, undefined, {}, { files: null }, { mode: "real" }, [1]])(
    "refuses malformed plans %j",
    (p) => {
      const s = beginWindowsIoModel(p);
      expect(s.firstError).toBe("archive_io_plan_invalid");
      expect(s.pending).toBeNull();
    },
  );
  it.each([
    null,
    {},
    { type: "unknown" },
    { type: "settled", request: 1, reply: {} },
    { type: "settled", request: 1, reply: { operation: Symbol(), bound: [null] } },
  ])("refuses unknown events and retains pending references", (e) => {
    const s = beginWindowsIoModel(plan());
    const result = advanceWindowsIoModel(s, e);
    expect(result.firstError).toBe("archive_io_event_invalid");
    expect(result.pending).toBe(s.pending);
    expect(planWindowsModelCleanup(result, [], false)).toEqual([]);
  });
  it.each([
    "relativeSingleComponent",
    "continuousChildren",
    "rootRelativeNoReplace",
    "fileAndDirectoryDurability",
    "id128",
  ] as const)("closes an unproven %s gate", (gate) => {
    const p = plan();
    const s = beginWindowsIoModel({ ...p, capabilities: { ...p.capabilities, [gate]: false } });
    expect(s.phase).toBe("failed");
    expect(s.pending).toBeNull();
    expect(s.ackCandidate).toBe(false);
  });
  it.each([0, 1, 2])(
    "requires independent provenance at every existing chain position %s",
    (index) => {
      const p = plan("read-file");
      const anchors = p.anchors.map((a, i) =>
        i === index ? { ...a, provenance: "snapshot-copy" } : a,
      );
      expect(beginWindowsIoModel({ ...p, anchors }).firstError).toBe("archive_io_trust_missing");
      const fake = new WindowsIoFake();
      const s = beginWindowsIoModel(p);
      const result = fake.step(s, (r) => ({
        ...r,
        bound:
          r.bound?.map((b, i) =>
            i === index ? { ...b, observation: p.anchors[0]?.record ?? Symbol() } : b,
          ) ?? [],
      }));
      expect(result.firstError).toBe("archive_io_trust_missing");
    },
  );
  it.each(["posix-pin", "missing"])("rejects %s provenance", (provenance) => {
    const p = plan();
    expect(
      beginWindowsIoModel({ ...p, anchors: p.anchors.map((a) => ({ ...a, provenance })) })
        .firstError,
    ).toBe("archive_io_trust_missing");
  });
  it.each(["C:\\archive:stream", "\\\\server\\archive", "c:\\archive", "C:\\ARCHIVE"])(
    "rejects acquisition alias %s",
    (acquisitionPath) => {
      expect(beginWindowsIoModel({ ...plan(), acquisitionPath }).pending).toBeNull();
    },
  );
  it.each(["..", ".", "", "CON", "COM¹.txt", "a.", "a ", "a:b", "a/b", "a\\b", "ARCHIV~1", "a\n"])(
    "rejects unsafe relative component %j before IO",
    (stage) => {
      expect(beginWindowsIoModel({ ...plan(), stage }).firstError).toBe("archive_io_path_invalid");
    },
  );
  it("rejects case-colliding names, multiple standalone files, and size/entry limits", () => {
    const p = plan();
    const first = p.files[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(
      beginWindowsIoModel({ ...p, files: [first, { ...first, name: "RESULT.txt" }] }).firstError,
    ).toBe("archive_filename_collision");
    expect(
      beginWindowsIoModel({
        ...plan("create-file"),
        files: [first, { ...first, name: "other.txt" }],
      }).firstError,
    ).toBe("archive_io_plan_invalid");
    expect(
      beginWindowsIoModel({ ...p, files: [{ ...first, bytes: new Array(16 * 1024 * 1024 + 1) }] })
        .firstError,
    ).toBe("archive_size_limit");
    expect(
      beginWindowsIoModel({
        ...p,
        files: Array.from({ length: 129 }, (_, i) => ({ ...first, name: `f${i}`, bytes: [] })),
      }).firstError,
    ).toBe("archive_size_limit");
    expect(
      beginWindowsIoModel({
        ...p,
        files: Array.from({ length: 5 }, (_, i) => ({
          ...first,
          name: `f${i}`,
          bytes: new Array(16 * 1024 * 1024),
        })),
      }).firstError,
    ).toBe("archive_size_limit");
    expect(beginWindowsIoModel({ ...p, files: [{ ...first, bytes: [256] }] }).firstError).toBe(
      "archive_size_limit",
    );
  });
  it.each([
    ["id", "9".repeat(32)],
    ["ownerHash", "4".repeat(64)],
    ["daclHash", "4".repeat(64)],
    ["links", 2],
    ["reparse", 1],
    ["deletePending", true],
    ["attributes", 0x12],
    ["size", 1],
    ["path", "C:\\elsewhere"],
  ] as const)("detects %s mutation at checkpoints even with fixed sharing", (key, value) => {
    const fake = new WindowsIoFake();
    const s = fake.until(beginWindowsIoModel(plan()), "C1");
    const result = fake.step(s, (r) => ({
      ...r,
      observations:
        r.observations?.map((o, i) =>
          i === 1 ? { ...o, facts: { ...o.facts, [key]: value } } : o,
        ) ?? [],
    }));
    expect(result.phase).toBe("failed");
    expect(result.ackCandidate).toBe(false);
    expect(fake.commands.some((c) => c.kind === "write")).toBe(false);
  });
  it("records the comparison limit for change-and-restore", () => {
    const fake = new WindowsIoFake();
    // Restored ACL values are indistinguishable from unchanged observations.
    expect(fake.until(beginWindowsIoModel(plan())).ackCandidate).toBe(true);
  });
  it("rejects stale policy or wrong IO/content references", () => {
    for (const phase of ["C1", "write", "rename", "published-content"] as const) {
      const fake = new WindowsIoFake();
      const s = fake.until(beginWindowsIoModel(plan()), phase);
      const r = fake.step(s, (reply) =>
        phase === "C1"
          ? {
              ...reply,
              policy: {
                status: "candidate",
                operation: Symbol("stale"),
                references: s.bound.map((b) => b.ref),
              },
            }
          : phase === "published-content"
            ? { ...reply, contentReferences: [Symbol("foreign")] }
            : { ...reply, ioReference: Symbol("foreign") },
      );
      expect(r.firstError).not.toBeNull();
      expect(r.dbCommitted).toBe(false);
      expect(r.ackCandidate).toBe(false);
    }
  });
  it.each([0, -1, 4, Number.NaN, 0.5])("rejects invalid write progress %s", (written) => {
    const fake = new WindowsIoFake();
    const s = fake.until(beginWindowsIoModel(plan()), "write");
    expect(fake.step(s, (r) => ({ ...r, written })).firstError).toBe("archive_io_write_progress");
  });
  it.each([
    "readback",
    "file-flush",
    "stage-directory-flush",
    "rename",
    "C3",
    "published-content",
    "destination-directory-flush",
    "db-commit",
  ] as const)("fails %s without inferred ACK or unsafe publication cleanup", (phase) => {
    const fake = new WindowsIoFake();
    const s = fake.until(beginWindowsIoModel(plan()), phase);
    const r = fake.step(s, (reply) =>
      phase === "C3"
        ? { ...reply, observations: [] }
        : phase === "readback"
          ? { ...reply, bytes: [9] }
          : phase === "published-content"
            ? { ...reply, contents: [[9]] }
            : { ...reply, done: false },
    );
    expect(r.phase).toBe("failed");
    expect(r.ackCandidate).toBe(false);
    expect(r.dbCommitted).toBe(false);
    if (r.published) expect(planWindowsModelCleanup(r, observations(r, true), false)).toEqual([]);
  });
  it.each(["read", "eof", "C2-read"] as const)(
    "rejects read/EOF/checkpoint mismatch at %s",
    (phase) => {
      const fake = new WindowsIoFake();
      const s = fake.until(beginWindowsIoModel(plan("read-file")), phase);
      expect(
        fake.step(s, (r) =>
          phase === "read"
            ? { ...r, bytes: [9] }
            : phase === "eof"
              ? { ...r, eof: false }
              : { ...r, observations: [] },
        ).phase,
      ).toBe("failed");
    },
  );
  it.each([
    "archive_io_busy",
    "archive_io_exists",
    "archive_io_denied",
    "archive_io_cancelled",
    "private adapter detail",
  ])("does not retry adapter error %s or leak detail", (error) => {
    const fake = new WindowsIoFake();
    const s = fake.step(beginWindowsIoModel(plan()), (r) => ({ ...r, error }));
    expect(s.firstError).toBe(error.startsWith("archive_io_") ? error : "archive_io_adapter_error");
    expect(s.pending).toBeNull();
    expect(fake.commands).toHaveLength(1);
  });
  it("rejects out-of-order, wrong-operation and duplicate settlements while draining issued IO", () => {
    for (const change of ["request", "operation", "duplicate"]) {
      const fake = new WindowsIoFake();
      const s = beginWindowsIoModel(plan());
      const reply = fake.reply(s);
      const event = { type: "settled", request: s.pending?.request, reply };
      const result =
        change === "duplicate"
          ? advanceWindowsIoModel(advanceWindowsIoModel(s, event), event)
          : advanceWindowsIoModel(s, {
              ...event,
              ...(change === "request"
                ? { request: 99 }
                : { reply: { ...reply, operation: Symbol() } }),
            });
      expect(result.firstError).toBe("archive_io_completion_unmatched");
      expect(result.pending).not.toBeNull();
      expect(fake.until(result).phase).toBe("failed");
    }
  });
  it.each([
    "acquire",
    "create-stage",
    "create-file",
    "write",
    "rename",
    "db-commit",
    "close",
  ] as const)("timeout at %s retains pending IO until terminal completion", (phase) => {
    const fake = new WindowsIoFake();
    const s =
      phase === "close"
        ? advanceWindowsIoModel(fake.until(beginWindowsIoModel(plan())), { type: "close" })
        : fake.until(beginWindowsIoModel(plan()), phase);
    const timed = advanceWindowsIoModel(s, { type: "timeout" });
    expect(timed.pending).toBe(s.pending);
    expect(advanceWindowsIoModel(timed, { type: "cancel-returned" })).toBe(timed);
    expect(advanceWindowsIoModel(timed, { type: "close" })).toBe(timed);
    expect(planWindowsModelCleanup(timed, observations(timed, true), false)).toEqual([]);
    const completedLate = fake.step(timed);
    expect(completedLate.pending).toBeNull();
    expect(completedLate.firstError).toBe("archive_io_timeout");
    expect(completedLate.ackCandidate).toBe(false);
    expect(completedLate.phase).toBe(phase === "close" ? "closed" : "failed");
    if (["acquire", "create-stage", "create-file"].includes(phase))
      expect(completedLate.bound.length).toBeGreaterThan(s.bound.length);
    if (phase === "db-commit") expect(completedLate.dbCommitted).toBe(true);
    if (phase === "rename") expect(completedLate.published).toBe(true);
  });
  it("preserves the first error on failed close and retries only explicit close", () => {
    const fake = new WindowsIoFake();
    const failed = fake.step(beginWindowsIoModel(plan()), (r) => ({
      ...r,
      error: "archive_io_denied",
    }));
    const closing = advanceWindowsIoModel(failed, { type: "close" });
    const result = fake.step(closing, (r) => ({ ...r, closedReferences: [] }));
    expect(result.firstError).toBe("archive_io_denied");
    expect(result.bound.length).toBeGreaterThan(0);
    expect(fake.step(advanceWindowsIoModel(result, { type: "close" })).phase).toBe("closed");
  });
  it("plans cleanup bottom-up only for verified owned children and preserves failure", () => {
    const fake = new WindowsIoFake();
    const s = fake.until(beginWindowsIoModel(plan()), "write");
    const failed = fake.step(s, (r) => ({ ...r, written: 0 }));
    const obs = observations(failed, false);
    expect(planWindowsModelCleanup(failed, obs, false)).toEqual(
      failed.bound
        .filter((b) => b.created)
        .map((b) => b.ref)
        .reverse(),
    );
    expect(planWindowsModelCleanup(failed, obs, true)).toEqual([]);
    expect(planWindowsModelCleanup(failed, obs, undefined)).toEqual([]);
    expect(planWindowsModelCleanup(failed, null, false)).toEqual([]);
    const result = advanceWindowsIoModel(failed, { type: "cleanup-failed" });
    expect(result.firstError).toBe("archive_io_write_progress");
    expect(result.cleanupError).toBe("archive_io_cleanup_failed");
    expect(result.bound).toBe(failed.bound);
    for (const mutation of [
      { path: "C:\\foreign" },
      { reparse: 1 },
      { id: "9".repeat(32) },
      { attributes: 0x12 },
      { size: 1 },
    ] satisfies Partial<ModelFacts>[]) {
      expect(
        planWindowsModelCleanup(
          failed,
          obs.map((o, i) => (i === 1 ? { ...o, facts: { ...o.facts, ...mutation } } : o)),
          false,
        ),
      ).toEqual([]);
    }
  });
  it("does not accept extra handles on an unrelated completion", () => {
    const fake = new WindowsIoFake();
    const s = fake.until(beginWindowsIoModel(plan()), "write");
    const extra = s.bound[0];
    if (!extra) throw new Error("fixture missing bound");
    expect(
      fake.step(s, (r) => ({ ...r, bound: [{ ...extra, ref: Symbol("unsolicited") }] })).firstError,
    ).toBe("archive_io_binding_lost");
  });
});

describe("content recovery preserves existing receipt criteria", () => {
  it("refuses root-only trust and omitted required leaves despite a completeness claim", () => {
    const e = recovery();
    for (const currentChain of [e.currentChain.slice(0, 1), e.currentChain.slice(0, 2)])
      expect(classifyWindowsRecoveryModel({ ...e, currentChain }).ackCandidate).toBe(false);
    expect(
      classifyWindowsRecoveryModel({ ...e, requiredFiles: ["missing.txt"] }).ackCandidate,
    ).toBe(false);
    expect(classifyWindowsRecoveryModel({ ...e, requiredFiles: [] }).ackCandidate).toBe(false);
  });
  it.each(["absent", "missing-file", "mismatch"] as const)(
    "DB committed plus %s remains incomplete/noACK",
    (destination) => {
      for (const staging of ["none", "partial", "complete"] as const) {
        const result = classifyWindowsRecoveryModel(recovery({ destination, staging }));
        expect(result.status).toBe("incomplete");
        expect(result.ackCandidate).toBe(false);
        expect(result.wouldCommitDb).toBe(false);
        expect(result.preserveStaging).toBe(true);
      }
    },
  );
  it.each(["partial", "complete"] as const)("never adopts staging-only %s", (staging) => {
    expect(
      classifyWindowsRecoveryModel(recovery({ destination: "absent", staging, dbCommitted: false }))
        .wouldCommitDb,
    ).toBe(false);
  });
  it("requires both directory durability and full current-chain provenance", () => {
    for (const e of [
      recovery({ fileAndDirectoryDurable: false }),
      recovery({ fullChainIndependent: false }),
      recovery({ currentChain: [] }),
    ]) {
      expect(classifyWindowsRecoveryModel(e).ackCandidate).toBe(false);
    }
    const e = recovery();
    for (let index = 0; index < e.currentChain.length; index++) {
      const currentChain = e.currentChain.map((item, i) =>
        i === index
          ? { ...item, expected: { ...item.expected, provenance: "snapshot-copy" as const } }
          : item,
      );
      expect(classifyWindowsRecoveryModel({ ...e, currentChain }).ackCandidate).toBe(false);
      const copied = e.currentChain.map((item, i) =>
        i === index
          ? { ...item, observed: { ...item.observed, observation: item.expected.record } }
          : item,
      );
      expect(classifyWindowsRecoveryModel({ ...e, currentChain: copied }).ackCandidate).toBe(false);
    }
  });
  it("preserves orphan staging and allows only a content candidate, without prior identity promises", () => {
    const e = recovery({ staging: "complete", dbCommitted: false });
    const candidate = classifyWindowsRecoveryModel(e);
    expect(candidate.wouldCommitDb).toBe(true);
    expect(candidate.ackCandidate).toBe(false);
    expect(candidate.preserveStaging).toBe(true);
    const currentChain = e.currentChain.map((item, i) =>
      i === 2
        ? {
            ...item,
            expected: { ...item.expected, facts: { ...item.expected.facts, id: "8".repeat(32) } },
            observed: { ...item.observed, facts: { ...item.observed.facts, id: "8".repeat(32) } },
          }
        : item,
    );
    const later = classifyWindowsRecoveryModel({ ...e, currentChain, dbCommitted: true });
    expect(later.ackCandidate).toBe(true);
    expect(later.detectsPreviousSameBytesIdentityReplacement).toBe(false);
    expect(later.windowsStorageEnabled).toBe(false);
  });
  it.each([null, {}, { destination: "unknown" }, { ...recovery(), dbCommitted: "yes" }])(
    "fails closed for unknown recovery %j",
    (e) => {
      expect(classifyWindowsRecoveryModel(e).status).toBe("incomplete");
    },
  );
});
