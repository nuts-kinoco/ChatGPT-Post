import assert from "node:assert/strict";
import test from "node:test";
import { parseTestSummary, sourceMetadata } from "./verification-summary.mjs";
test("counts skipped tests, not skipped test files", () => {
  assert.deepEqual(
    parseTestSummary("Test Files 1 passed | 1 skipped (2)\n Tests 1 passed | 2 skipped (3)\n"),
    { format: "vitest", passed: 1, failed: 0, skipped: 2, cancelled: 0, todo: 0, total: 3 },
  );
});
test("handles color, failure, todo and all-skipped summaries", () => {
  assert.equal(
    parseTestSummary("\u001b[31mTests\u001b[0m 2 failed | 4 passed | 3 skipped | 1 todo (10)")
      ?.failed,
    2,
  );
  assert.equal(parseTestSummary("Tests 56 skipped (56)")?.skipped, 56);
  assert.equal(parseTestSummary("Tests 12 passed")?.passed, 12);
});
test("missing/truncated/wrong summary is unknown", () => {
  for (const text of [
    "Test Files 3 passed | 7 skipped",
    "my pass 999 text",
    "4 skipped elsewhere",
    "Tests 4 passed | 3 skipped (8)",
    "Tests 1 passed | 1 passed",
    "Tests 1 pending",
    "Tests 9007199254740992 passed",
  ])
    assert.equal(parseTestSummary(text), null);
});
test("reads Node TAP and spec exact summary fields", () => {
  for (const p of ["#", "ℹ"])
    assert.deepEqual(
      parseTestSummary(
        `${p} tests 5\n${p} pass 2\n${p} fail 1\n${p} cancelled 1\n${p} skipped 1\n${p} todo 0\n`,
      ),
      { format: "node-test", passed: 2, failed: 1, cancelled: 1, skipped: 1, todo: 0, total: 5 },
    );
  assert.equal(parseTestSummary("# tests 1\n# pass 1\n"), null);
  assert.equal(
    parseTestSummary("# tests 9\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0"),
    null,
  );
});
test("uses final Vitest and explicit compiled completion lines", () => {
  assert.equal(parseTestSummary("Tests 9 passed\nTests 2 passed | 3 skipped (5)")?.total, 5);
  assert.equal(
    parseTestSummary("12 compiled issuer CLI cases passed; inert ports only")?.passed,
    12,
  );
  assert.equal(
    parseTestSummary("6 compiled CLI lifecycle cases passed; fake deployment only")?.passed,
    6,
  );
  assert.equal(parseTestSummary("PASS main/pending: same owner drained before exit"), null);
});
test("Git unavailable never means a clean tree", () => {
  assert.deepEqual(sourceMetadata({ status: 128, stdout: "" }, { status: 128, stdout: "" }), {
    sourceHead: null,
    dirty: null,
    sourceState: "unavailable",
  });
  const head = { status: 0, stdout: `${"a".repeat(40)}\n` };
  assert.equal(
    sourceMetadata(head, { status: 128, stdout: "" }, "matched").sourceState,
    "head_only",
  );
  assert.equal(sourceMetadata(head, { status: 0, stdout: "" }, "matched").sourceState, "clean");
  assert.equal(
    sourceMetadata(head, { status: 0, stdout: " M file\n" }, "matched").sourceState,
    "dirty",
  );
  assert.equal(
    sourceMetadata({ status: 0, stdout: "not-a-hash" }, { status: 0, stdout: "" }).sourceHead,
    null,
  );
});
import { phaseOutcome } from "./verification-summary.mjs";
test("missing summary is blocked rather than zero skips; failed/todo counts matter", () => {
  assert.equal(phaseOutcome(0, null, true, null).state, "blocked");
  assert.equal(phaseOutcome(0, null, true, null).skipped, null);
  assert.equal(phaseOutcome(0, null, true, parseTestSummary("Tests 1 failed")).state, "failed");
  assert.equal(
    phaseOutcome(0, null, true, parseTestSummary("Tests 1 todo")).state,
    "passed_with_skips",
  );
  assert.equal(phaseOutcome(0, null, false, null).state, "passed");
  assert.equal(phaseOutcome(null, "ETIMEDOUT", false, null).state, "blocked");
});
import { OFFLINE_VERIFICATION_ENV } from "./verification-summary.mjs";
test("the fixed runner overrides a live-selection environment flag", () => {
  assert.equal({ ...{ BRIDGE_LIVE: "1" }, ...OFFLINE_VERIFICATION_ENV }.BRIDGE_LIVE, "0");
  assert.equal(Object.isFrozen(OFFLINE_VERIFICATION_ENV), true);
});
test("never combines fields from an earlier Node summary with a truncated final block", () => {
  const complete = "# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  assert.equal(parseTestSummary(complete + "# tests 2\n# pass 2\n"), null);
  assert.equal(parseTestSummary(complete + "# tests\n"), null);
  assert.equal(parseTestSummary(complete + "# pass 2\n"), null);
  assert.equal(parseTestSummary(complete + complete)?.passed, 1);
  assert.equal(parseTestSummary("Tests 1 passed\nTests\n"), null);
});

import { repositoryRootIdentity } from "./verification-summary.mjs";
test("only the canonical script repository root can supply source identity", () => {
  const head = { status: 0, stdout: "a".repeat(40) },
    clean = { status: 0, stdout: "" };
  const same = repositoryRootIdentity("/project", { status: 0, stdout: "/project\n" }, (x) => x);
  assert.equal(same, "matched");
  assert.equal(sourceMetadata(head, clean, same).sourceState, "clean");
  const parent = repositoryRootIdentity(
    "/project/source-copy",
    { status: 0, stdout: "/project\n" },
    (x) => x,
  );
  assert.deepEqual(sourceMetadata(head, clean, parent), {
    sourceHead: null,
    dirty: null,
    sourceState: "root_mismatch",
  });
  assert.equal(
    repositoryRootIdentity("/project", { status: 1, stdout: "" }, (x) => x),
    "unavailable",
  );
  assert.equal(
    repositoryRootIdentity("/project", { status: 0, stdout: "/project" }, () => {
      throw new Error("filesystem");
    }),
    "unavailable",
  );
  assert.equal(sourceMetadata(head, clean).sourceState, "unavailable");
});

import {
  combinedSourceFields,
  runWithSourceEvidence,
  sourceEvidence,
  sourceStatusArgs,
  verificationExitCode,
} from "./verification-summary.mjs";
const sha = (c) => c.repeat(40);
const snap = (head, status, identity = "matched") =>
  sourceMetadata(
    head === null ? { status: 128, stdout: "" } : { status: 0, stdout: `${head}\n` },
    status === null ? { status: 128, stdout: "" } : { status: 0, stdout: status },
    identity,
  );
const clean = (c = "a") => snap(sha(c), "");
test("the same clean HEAD before and after is the only established fixed-head evidence", () => {
  const evidence = sourceEvidence(clean(), clean());
  assert.equal(evidence.status, "established");
  assert.equal(evidence.pinnedHead, sha("a"));
  assert.deepEqual(evidence.reasons, []);
  assert.deepEqual(combinedSourceFields(clean(), clean()), {
    sourceHead: sha("a"),
    dirty: false,
    sourceState: "clean",
  });
});
test("a different HEAD after the run is not fixed-head evidence", () => {
  const evidence = sourceEvidence(clean("a"), clean("b"));
  assert.equal(evidence.status, "not_established");
  assert.equal(evidence.pinnedHead, null);
  assert.deepEqual(evidence.reasons, ["head_changed"]);
  assert.deepEqual(combinedSourceFields(clean("a"), clean("b")), {
    sourceHead: null,
    dirty: false,
    sourceState: "head_changed",
  });
});
test("a dirty tree at the start or at the end is not fixed-head evidence", () => {
  const dirty = snap(sha("a"), " M file\n");
  assert.deepEqual(sourceEvidence(dirty, clean()).reasons, ["dirty_before"]);
  assert.deepEqual(sourceEvidence(clean(), dirty).reasons, ["dirty_after"]);
  assert.deepEqual(sourceEvidence(dirty, dirty).reasons, ["dirty_before", "dirty_after"]);
  assert.equal(sourceEvidence(dirty, dirty).status, "not_established");
  assert.deepEqual(combinedSourceFields(dirty, clean()), {
    sourceHead: sha("a"),
    dirty: true,
    sourceState: "dirty",
  });
});
test("Git information missing on one side never counts as clean or matching", () => {
  const unavailable = snap(null, null);
  const headOnly = snap(sha("a"), null);
  assert.deepEqual(sourceEvidence(clean(), unavailable).reasons, ["git_unavailable_after"]);
  assert.deepEqual(sourceEvidence(unavailable, clean()).reasons, ["git_unavailable_before"]);
  assert.deepEqual(sourceEvidence(clean(), headOnly).reasons, ["dirty_unknown_after"]);
  assert.equal(sourceEvidence(headOnly, headOnly).status, "not_established");
  assert.equal(sourceEvidence(undefined, clean()).status, "not_established");
  assert.deepEqual(combinedSourceFields(clean(), unavailable), {
    sourceHead: null,
    dirty: null,
    sourceState: "unavailable",
  });
  assert.deepEqual(combinedSourceFields(clean(), headOnly), {
    sourceHead: sha("a"),
    dirty: null,
    sourceState: "head_only",
  });
});
test("a repository root mismatch on either side is not fixed-head evidence", () => {
  const mismatch = snap(sha("a"), "", "mismatch");
  assert.deepEqual(sourceEvidence(mismatch, clean()).reasons, ["root_mismatch_before"]);
  assert.deepEqual(sourceEvidence(clean(), mismatch).reasons, ["root_mismatch_after"]);
  assert.equal(combinedSourceFields(clean(), mismatch).sourceState, "root_mismatch");
  assert.equal(combinedSourceFields(clean(), mismatch).sourceHead, null);
});
test("matching start and end snapshots do not claim whole-run immutability", () => {
  // A checkout that changes and returns, or a content edit inside an already-dirty tree, leaves
  // the two observations identical. The evidence carries its own limited scope.
  const evidence = sourceEvidence(clean(), clean());
  assert.equal(evidence.scope, "start_and_end_snapshots_only");
  const dirtyBefore = snap(sha("a"), " M file\n");
  const dirtyAfter = snap(sha("a"), " M file\n M other\n");
  assert.equal(sourceEvidence(dirtyBefore, dirtyAfter).status, "not_established");
});
test("the start snapshot is taken before any phase begins and the end one after the last", () => {
  const events = [];
  const heads = [sha("a"), sha("b")]; // start snapshot, then end snapshot
  const out = runWithSourceEvidence(["p1", "p2"], {
    capture: () => {
      events.push("capture");
      return snap(heads.shift(), "");
    },
    runPhase: (phase) => {
      events.push(phase);
      return { phase };
    },
  });
  assert.deepEqual(events, ["capture", "p1", "p2", "capture"]);
  assert.deepEqual(out.results, [{ phase: "p1" }, { phase: "p2" }]);
  assert.equal(out.sourceBefore.sourceHead, sha("a"));
  assert.equal(out.sourceAfter.sourceHead, sha("b"));
  assert.deepEqual(out.evidence.reasons, ["head_changed"]);
});
test("a HEAD change during the run is reported even when every phase passed", () => {
  let current = sha("a");
  const out = runWithSourceEvidence(["p1", "p2", "p3"], {
    capture: () => snap(current, ""),
    runPhase: (phase) => {
      if (phase === "p2") current = sha("b");
      return { phase, state: "passed" };
    },
  });
  assert.equal(
    out.results.every((r) => r.state === "passed"),
    true,
  );
  assert.equal(out.evidence.status, "not_established");
  assert.equal(
    verificationExitCode({
      failed: false,
      skipped: false,
      strict: true,
      evidenceEstablished: out.evidence.status === "established",
    }),
    3,
  );
});
test("exit values keep 0/1/2 and add 3 only for strict runs without source evidence", () => {
  const code = (failed, skipped, strict, evidenceEstablished) =>
    verificationExitCode({ failed, skipped, strict, evidenceEstablished });
  assert.equal(code(false, false, true, true), 0);
  assert.equal(code(true, false, false, true), 1);
  assert.equal(code(true, true, true, false), 1, "a failed phase stays 1");
  assert.equal(code(false, true, true, true), 2);
  assert.equal(code(false, true, true, false), 2, "skips are reported before missing evidence");
  assert.equal(code(false, false, true, false), 3);
  assert.equal(code(false, false, false, false), 0, "non-strict exit values are unchanged");
  assert.equal(code(false, true, false, true), 0);
});
test("the evidence directory inside the repository is excluded from the dirty check only", () => {
  assert.deepEqual(sourceStatusArgs("/repo", "/other/run"), ["status", "--porcelain"]);
  assert.deepEqual(sourceStatusArgs("/repo", "/repo"), ["status", "--porcelain"]);
  assert.deepEqual(sourceStatusArgs("/repo", "/repo/runtime/verification/x"), [
    "status",
    "--porcelain",
    "--",
    ".",
    ":(exclude,literal)runtime/verification/x",
  ]);
  assert.deepEqual(sourceStatusArgs("/repo", "/repo-sibling/run"), ["status", "--porcelain"]);
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSourceStatus } from "./verification-summary.mjs";
test("output exclusion preserves tracked changes and fails closed when either status is unavailable", () => {
  for (const tracked of [
    " D output/source.txt\n",
    " M output/source.txt\n",
    "A  output/new.txt\n",
  ]) {
    const responses = [
      { status: 0, stdout: "" },
      { status: 0, stdout: tracked },
    ];
    const status = captureSourceStatus("/repo", "/repo/output", () => responses.shift());
    assert.equal(sourceMetadata({ status: 0, stdout: sha("a") }, status, "matched").dirty, true);
  }
  for (const failedIndex of [0, 1]) {
    const responses = [
      { status: 0, stdout: "" },
      { status: 0, stdout: "" },
    ];
    responses[failedIndex] = { status: 128, stdout: "" };
    const status = captureSourceStatus("/repo", "/repo/output", () => responses.shift());
    assert.equal(sourceMetadata({ status: 0, stdout: sha("a") }, status, "matched").dirty, null);
  }
  const calls = [];
  captureSourceStatus("/repo", "/outside/output", (args) => {
    calls.push(args);
    return { status: 0, stdout: "" };
  });
  assert.deepEqual(calls, [["status", "--porcelain"]]);
});
test("real Git cannot hide deleted tracked source under a newly created evidence directory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bridge-source-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const checkedGit = (args) => {
    const result = git(args);
    assert.equal(result.status, 0, `fixture git ${args[0]} failed`);
    return result;
  };
  checkedGit(["init", "-q"]);
  const output = join(root, "evidence");
  mkdirSync(output);
  writeFileSync(join(output, "tracked.txt"), "synthetic source");
  checkedGit(["add", "."]);
  checkedGit([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const head = checkedGit(["rev-parse", "HEAD"]);
  rmSync(output, { recursive: true });
  mkdirSync(output); // The runner accepts a new output directory after the tracked one was removed.
  writeFileSync(join(output, "run.log"), "synthetic evidence");
  assert.equal(
    checkedGit(sourceStatusArgs(root, output)).stdout,
    "",
    "the old exclusion hid the deletion",
  );
  const snapshot = sourceMetadata(head, captureSourceStatus(root, output, git), "matched");
  assert.equal(snapshot.dirty, true);
  assert.equal(sourceEvidence(snapshot, snapshot).status, "not_established");
  checkedGit(["restore", "evidence/tracked.txt"]);
  assert.equal(
    sourceMetadata(head, captureSourceStatus(root, output, git), "matched").dirty,
    false,
    "untracked run logs alone stay excluded",
  );
  writeFileSync(join(output, "tracked.txt"), "changed synthetic source");
  assert.equal(sourceMetadata(head, captureSourceStatus(root, output, git), "matched").dirty, true);
  checkedGit(["restore", "evidence/tracked.txt"]);
  writeFileSync(join(output, "new.txt"), "synthetic staged source");
  checkedGit(["add", "evidence/new.txt"]);
  assert.equal(sourceMetadata(head, captureSourceStatus(root, output, git), "matched").dirty, true);
});
