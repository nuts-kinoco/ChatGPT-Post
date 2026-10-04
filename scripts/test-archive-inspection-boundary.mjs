import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(repository, "dist/archive-inspection/error-boundary-test.exe");
const cases = [
  { args: [], exit: 0 },
  { args: ["pending-query-fails"], exit: 73 },
  { args: ["post-throw-query-fails"], exit: 73 },
  { args: ["throw-fails-no-pending"], exit: 73 },
  { args: ["throw-ok-no-pending"], exit: 73 },
];
for (const test of cases) {
  const result = spawnSync(executable, test.args, { encoding: "utf8", timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, test.exit);
  if (test.args.length === 0) assert.equal(result.stdout.trim(), "5 boundary cases passed");
}
console.log(
  JSON.stringify(
    {
      schema: "archive-inspection-boundary-report-1",
      passed: true,
      cases: 9,
      limits: [
        "Mock N-API status/exception state",
        "C++ operator-new injection",
        "No actual V8/OS OOM exhaustion",
        "Fatal API replaced with owned-test exit sentinel",
      ],
    },
    null,
    2,
  ),
);
