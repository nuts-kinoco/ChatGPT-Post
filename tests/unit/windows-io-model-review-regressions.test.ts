import { expect, it } from "vitest";
import {
  advanceWindowsIoModel,
  beginWindowsIoModel,
  classifyWindowsRecoveryModel,
} from "../../src/archive/windows-io-model.js";
import { facts, plan, recovery, scanRecovery, WindowsIoFake } from "../helpers/windows-io-fake.js";

it("recovery must bind evidence to requested parent/destination", () => {
  const p = plan("recover-scan");
  const foreign = recovery();
  const f = new WindowsIoFake();
  const pending = f.until(beginWindowsIoModel(p), "scan");
  // Requested C:\\archive\\published; evidence is C:\\foreign\\result.txt.
  f.recoveryEvidence = {
    ...foreign,
    destinationPath: "C:\\foreign",
    currentChain: foreign.currentChain.map((x) => ({
      ...x,
      expected: {
        ...x.expected,
        component: x.expected.component === "archive" ? "foreign" : x.expected.component,
        facts: { ...x.expected.facts, path: x.expected.facts.path.replace("archive", "foreign") },
      },
      observed: {
        ...x.observed,
        facts: { ...x.observed.facts, path: x.observed.facts.path.replace("archive", "foreign") },
      },
    })),
  };
  const out = f.step(pending);
  expect(out.recovery?.ackCandidate).toBe(false);
});
it("close errors must not be silently accepted", () => {
  const f = new WindowsIoFake();
  const done = f.until(beginWindowsIoModel(plan()));
  const closing = advanceWindowsIoModel(done, { type: "close" });
  const out = f.step(closing, (r) => ({ ...r, error: "archive_io_denied" }));
  expect(out.firstError).toBe("archive_io_close_failed");
});
it("128 supported required files must fit recovery chain", () => {
  const p = plan();
  const file = p.files[0];
  if (!file) throw new Error("missing fixture file");
  const f = new WindowsIoFake();
  const published = f.until(
    beginWindowsIoModel({
      ...p,
      files: Array.from({ length: 128 }, (_, i) => ({
        ...file,
        name: `f${i}.txt`,
        bytes: [],
      })),
    }),
  );
  expect(published.ackCandidate).toBe(true);
  const e = recovery();
  const leaf = e.currentChain[2];
  if (!leaf) throw new Error("missing fixture leaf");
  const files = Array.from({ length: 128 }, (_, i) => {
    const name = `f${i}.txt`;
    const id = (1000 + i).toString(16).padStart(32, "0");
    return {
      expected: {
        ...leaf.expected,
        component: name,
        record: Symbol(),
        facts: { ...leaf.expected.facts, path: `C:\\archive\\${name}`, id },
      },
      observed: {
        ...leaf.observed,
        ref: Symbol(),
        observation: Symbol(),
        facts: { ...leaf.observed.facts, path: `C:\\archive\\${name}`, id },
      },
    };
  });
  expect(
    classifyWindowsRecoveryModel({
      ...e,
      requiredFiles: files.map((x) => x.expected.component),
      currentChain: [...e.currentChain.slice(0, 2), ...files],
    }).ackCandidate,
  ).toBe(true);
});
it("cancellation without a preceding timeout must not resume publication", () => {
  const f = new WindowsIoFake();
  const pending = f.until(beginWindowsIoModel(plan()), "write");
  const cancelled = advanceWindowsIoModel(pending, { type: "cancel-returned" });
  expect(cancelled.pending).toBe(pending.pending);
  const out = f.until(cancelled);
  expect(out.ackCandidate).toBe(false);
  expect(out.dbCommitted).toBe(false);
});

it.each([
  "acquire",
  "create-stage",
  "create-file",
  "write",
  "rename",
  "db-commit",
  "close",
] as const)("cancellation at %s drains without issuing further work", (phase) => {
  const f = new WindowsIoFake();
  const pending =
    phase === "close"
      ? advanceWindowsIoModel(f.until(beginWindowsIoModel(plan())), { type: "close" })
      : f.until(beginWindowsIoModel(plan()), phase);
  const cancelled = advanceWindowsIoModel(pending, { type: "cancel-returned" });
  expect(cancelled.pending).toBe(pending.pending);
  expect(cancelled.cancellationRequested).toBe(true);
  expect(cancelled.firstError).toBe("archive_io_cancelled");
  expect(advanceWindowsIoModel(cancelled, { type: "cancel-returned" })).toBe(cancelled);
  expect(advanceWindowsIoModel(cancelled, { type: "close" })).toBe(cancelled);
  const out = f.step(cancelled);
  expect(out.pending).toBeNull();
  expect(out.phase).toBe(phase === "close" ? "closed" : "failed");
  expect(out.firstError).toBe("archive_io_cancelled");
  expect(out.ackCandidate).toBe(false);
  if (["acquire", "create-stage", "create-file"].includes(phase))
    expect(out.bound.length).toBeGreaterThan(pending.bound.length);
  expect(out.published).toBe(pending.published || phase === "rename");
  expect(out.dbCommitted).toBe(pending.dbCommitted || phase === "db-commit");
});
it("cancellation preserves an earlier failure and prevents late publication", () => {
  const f = new WindowsIoFake();
  const pending = f.until(beginWindowsIoModel(plan()), "write");
  const failed = advanceWindowsIoModel(pending, {
    type: "settled",
    request: -1,
    reply: { operation: pending.operation },
  });
  const cancelled = advanceWindowsIoModel(failed, { type: "cancel-returned" });
  expect(f.until(cancelled).firstError).toBe("archive_io_completion_unmatched");
  expect(f.commands.some((c) => c.kind === "rename" || c.kind === "db-commit")).toBe(false);
});
it.each(["archive_io_denied", "unknown error", ""])(
  "explicit close error %j retains uncertain references",
  (error) => {
    const f = new WindowsIoFake();
    const done = f.until(beginWindowsIoModel(plan()));
    const out = f.step(advanceWindowsIoModel(done, { type: "close" }), (r) => ({ ...r, error }));
    expect(out.firstError).toBe("archive_io_close_failed");
    expect(out.phase).toBe("failed");
    expect(out.bound).toEqual(done.bound);
    expect(out.ackCandidate).toBe(false);
    expect(f.step(advanceWindowsIoModel(out, { type: "close" })).phase).toBe("closed");
  },
);
it("a contradictory close keeps the original error", () => {
  const f = new WindowsIoFake();
  const failed = f.step(beginWindowsIoModel(plan()), (r) => ({ ...r, error: "archive_io_denied" }));
  const out = f.step(advanceWindowsIoModel(failed, { type: "close" }), (r) => ({
    ...r,
    error: "archive_io_busy",
  }));
  expect(out.firstError).toBe("archive_io_denied");
  expect(out.bound).toEqual(failed.bound);
});
it.each([
  "destination",
  "required-files",
  "anchor-record",
  "ancestor-identity",
  "ancestor-reference",
  "policy-operation",
  "policy-reference",
  "missing-policy",
])("scan rejects mismatched %s", (mismatch) => {
  const f = new WindowsIoFake();
  const pending = f.until(beginWindowsIoModel(plan("recover-scan")), "scan");
  const out = f.step(pending, (r) => {
    const e = r.recovery;
    const policy = r.policy;
    if (!e || !policy) throw new Error("missing scan fixture");
    if (mismatch === "destination")
      return { ...r, recovery: { ...e, destinationPath: "C:\\foreign" } };
    if (mismatch === "required-files")
      return { ...r, recovery: { ...e, requiredFiles: ["other.txt"] } };
    if (mismatch === "policy-operation")
      return { ...r, policy: { ...policy, operation: Symbol() } };
    if (mismatch === "policy-reference")
      return { ...r, policy: { ...policy, references: policy.references.map(() => Symbol()) } };
    if (mismatch === "missing-policy") {
      const { policy: _policy, ...rest } = r;
      return rest;
    }
    return {
      ...r,
      recovery: {
        ...e,
        currentChain: e.currentChain.map((item, i) =>
          i !== 1
            ? item
            : {
                expected: {
                  ...item.expected,
                  ...(mismatch === "anchor-record" ? { record: Symbol() } : {}),
                  ...(mismatch === "ancestor-identity"
                    ? { facts: { ...item.expected.facts, id: "e".repeat(32) } }
                    : {}),
                },
                observed: {
                  ...item.observed,
                  ...(mismatch === "ancestor-reference" ? { ref: Symbol() } : {}),
                  ...(mismatch === "ancestor-identity"
                    ? { facts: { ...item.observed.facts, id: "e".repeat(32) } }
                    : {}),
                },
              },
        ),
      },
    };
  });
  expect(out.firstError).toBe("archive_io_scan_invalid");
  expect(out.recovery?.ackCandidate).toBe(false);
  expect(out.recovery?.wouldCommitDb).toBe(false);
});
it.each([true, false])(
  "valid scoped scan preserves DB state %s without native activation",
  (dbCommitted) => {
    const f = new WindowsIoFake();
    const pending = f.until(beginWindowsIoModel(plan("recover-scan")), "scan");
    f.recoveryEvidence = { ...scanRecovery(pending), dbCommitted };
    const out = f.step(pending);
    expect(out.firstError).toBeNull();
    expect(out.recovery?.ackCandidate).toBe(dbCommitted);
    expect(out.recovery?.wouldCommitDb).toBe(!dbCommitted);
    expect(out.windowsStorageEnabled).toBe(false);
    expect(out.recovery?.detectsPreviousSameBytesIdentityReplacement).toBe(false);
  },
);
it.each([128, 129])("publication and scoped recovery enforce the %s file boundary", (count) => {
  const p = plan();
  const file = p.files[0];
  if (!file) throw new Error("missing fixture file");
  const files = Array.from({ length: count }, (_, i) => ({
    ...file,
    name: `f${i}.txt`,
    bytes: [],
  }));
  const f = new WindowsIoFake();
  const published = f.until(beginWindowsIoModel({ ...p, files }));
  expect(published.ackCandidate).toBe(count === 128);
  const scan = f.until(beginWindowsIoModel({ ...plan("recover-scan"), files }));
  expect(scan.recovery?.ackCandidate ?? false).toBe(count === 128);
});
it.each([128, 129])(
  "recovery keeps the %s ancestor boundary separate from destination/files",
  (count) => {
    const p = plan();
    let path = "C:\\";
    const anchors = Array.from({ length: count }, (_, i) => {
      const component = i === 0 ? path : `a${i}`;
      if (i > 0) path = `${path}${i === 1 ? "" : "\\"}${component}`;
      return {
        component,
        facts: facts(i + 1, path),
        provenance: "independent" as const,
        record: Symbol(),
      };
    });
    const f = new WindowsIoFake();
    const custom = { ...p, anchors, acquisitionPath: path };
    expect(f.until(beginWindowsIoModel(custom)).ackCandidate).toBe(count === 128);
    const scan = f.until(beginWindowsIoModel({ ...custom, verb: "recover-scan" }));
    expect(scan.recovery?.ackCandidate ?? false).toBe(count === 128);
    // Independently exercise classifier bounds, without plan validation short-circuiting.
    const chain = anchors.map((expected) => ({
      expected,
      observed: { facts: expected.facts, ref: Symbol(), observation: Symbol(), created: false },
    }));
    const destination = facts(1000, `${path}\\published`);
    const leaf = facts(1001, `${destination.path}\\result.txt`, true);
    for (const f of [destination, leaf])
      chain.push({
        expected: {
          component: f.kind === "directory" ? "published" : "result.txt",
          facts: f,
          provenance: "independent",
          record: Symbol(),
        },
        observed: { facts: f, ref: Symbol(), observation: Symbol(), created: false },
      });
    expect(
      classifyWindowsRecoveryModel(
        recovery({ destinationPath: destination.path, currentChain: chain }),
      ).ackCandidate,
    ).toBe(count === 128);
  },
);

it.each(["none", "cancel", "timeout", "error"])(
  "scan retains and closes every acquired reference after %s",
  (interruption) => {
    const f = new WindowsIoFake();
    let pending = f.until(beginWindowsIoModel(plan("recover-scan")), "scan");
    const reply = f.reply(pending);
    const request = pending.pending?.request;
    if (request === undefined || !reply.recovery) throw new Error("missing scan fixture");
    const refs = reply.recovery.currentChain.map((item) => item.observed.ref);
    if (interruption === "cancel")
      pending = advanceWindowsIoModel(pending, { type: "cancel-returned" });
    if (interruption === "timeout") pending = advanceWindowsIoModel(pending, { type: "timeout" });
    const result = advanceWindowsIoModel(pending, {
      type: "settled",
      request,
      reply: { ...reply, ...(interruption === "error" ? { error: "archive_io_denied" } : {}) },
    });
    expect(result.bound.map((b) => b.ref)).toEqual(refs);
    expect(result.bound.every((b) => !b.created)).toBe(true);
    if (interruption !== "none") {
      expect(result.phase).toBe("failed");
      expect(result.ackCandidate).toBe(false);
      expect(result.recovery?.ackCandidate ?? false).toBe(false);
    }
    const closing = advanceWindowsIoModel(result, { type: "close" });
    expect(closing.pending?.references).toEqual(refs);
    const partial = f.step(closing, (r) => ({ ...r, closedReferences: refs.slice(0, 2) }));
    expect(partial.phase).toBe("failed");
    expect(partial.bound.map((b) => b.ref)).toEqual(refs);
    const closed = f.step(advanceWindowsIoModel(partial, { type: "close" }));
    expect(closed.phase).toBe("closed");
    expect(closed.bound).toEqual([]);
    expect(closed.firstError).toBe(partial.firstError);
  },
);
it.each([
  "missing",
  "different-reference",
  "different-observation",
  "different-facts",
  "created",
  "duplicate",
  "foreign-scope",
])("scan rejects %s ownership evidence without adopting evidence-only references", (mismatch) => {
  const f = new WindowsIoFake();
  const pending = f.until(beginWindowsIoModel(plan("recover-scan")), "scan");
  const reply = f.reply(pending);
  const request = pending.pending?.request;
  if (!reply.bound || !reply.recovery || request === undefined)
    throw new Error("missing scan fixture");
  const bound =
    mismatch === "missing"
      ? []
      : reply.bound.map((b) => ({
          ...b,
          ...(mismatch === "different-reference" ? { ref: Symbol("owned-but-unrelated") } : {}),
          ...(mismatch === "different-observation" ? { observation: Symbol() } : {}),
          ...(mismatch === "different-facts" ? { facts: { ...b.facts, id: "e".repeat(32) } } : {}),
          ...(mismatch === "created" ? { created: true } : {}),
        }));
  const first = bound[0];
  if (mismatch === "duplicate" && first) bound.push(first);
  const result = advanceWindowsIoModel(pending, {
    type: "settled",
    request,
    reply: {
      ...reply,
      bound,
      ...(mismatch === "foreign-scope"
        ? { recovery: { ...reply.recovery, destinationPath: "C:\\foreign" } }
        : {}),
    },
  });
  expect(result.firstError).toBe("archive_io_scan_invalid");
  expect(result.recovery?.ackCandidate).toBe(false);
  const ownedRefs = [...pending.bound.map((b) => b.ref), ...new Set(bound.map((b) => b.ref))];
  expect(result.bound.map((b) => b.ref)).toEqual(ownedRefs);
  const closing = advanceWindowsIoModel(result, { type: "close" });
  expect(closing.pending?.references).toEqual(ownedRefs);
  expect(f.step(closing).bound).toEqual([]);
});
it("unmatched scan completion cannot import another operation's acquired references", () => {
  const f = new WindowsIoFake();
  const pending = f.until(beginWindowsIoModel(plan("recover-scan")), "scan");
  const out = f.step(pending, (r) => ({ ...r, operation: Symbol("other-operation") }));
  expect(out.pending).toBe(pending.pending);
  expect(out.bound).toBe(pending.bound);
  expect(out.firstError).toBe("archive_io_completion_unmatched");
  const drained = f.step(out);
  expect(drained.bound.length).toBe(pending.bound.length + 2);
  expect(drained.firstError).toBe("archive_io_completion_unmatched");
  expect(drained.recovery).toBeNull();
});
