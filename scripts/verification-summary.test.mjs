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
