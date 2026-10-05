import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows x64 native unit checks required");
}
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const binding = require(path.join(repository, "dist/archive-inspection/archive-inspection.node"));
const area = path.join(repository, "dist/archive-inspection/fixtures");
fs.mkdirSync(area, { recursive: true });
const fixture = fs.mkdtempSync(path.join(area, "owned-"));
let assertions = 0;
const results = [];
function test(name, callback) {
  callback();
  results.push({ name, passed: true });
}
function equal(actual, expected) {
  assertions++;
  assert.deepEqual(actual, expected);
}
function ok(value) {
  assertions++;
  assert.ok(value);
}
function fails(callback, expected) {
  assertions++;
  assert.throws(callback, (error) => error.code === expected);
}
function final(observation) {
  return observation.entries.at(-1);
}
try {
  const file = path.join(fixture, "sample.txt");
  fs.writeFileSync(file, "synthetic fixture; metadata checks only", { flag: "wx" });
  const first = binding.inspectChain(file);
  test("same handle metadata and all ancestors", () => {
    equal(first.schema, "archive-win32-observation-1");
    equal(first.entries[0].path, path.parse(file).root);
    equal(final(first).path, file);
    equal(first.entries.length, file.split("\\").length);
    for (const entry of first.entries) {
      ok(/^S-1-/.test(entry.ownerSid));
      ok(/^[a-f0-9]{16}$/.test(entry.volumeSerialBytes));
      ok(/^[a-f0-9]{32}$/.test(entry.fileId128));
      ok(/^(?:[a-f0-9]{2}){8,65535}$/.test(entry.daclHex));
      equal(entry.reparseTag, 0);
      equal(entry.attributes & 0x400, 0);
      equal(entry.finalPath.toUpperCase(), entry.path.toUpperCase());
      ok(entry.aceTypes.every((type) => type === 0 || type === 1));
    }
    ok(first.entries.slice(0, -1).every((entry) => entry.directory));
    equal(final(first).directory, false);
    equal(final(first).linkCount, 1);
    equal(Object.hasOwn(first, "trusted"), false);
    equal(Object.hasOwn(first, "available"), false);
  });
  test("repeat stable metadata", () => {
    equal(binding.inspectChain(file), first);
  });
  test("directory observation", () => {
    equal(final(binding.inspectChain(fixture)).directory, true);
  });
  test("hard link identity is observed without an access decision", () => {
    const alias = path.join(fixture, "alias.txt");
    fs.linkSync(file, alias);
    const a = final(binding.inspectChain(file));
    const b = final(binding.inspectChain(alias));
    equal(a.fileId128, b.fileId128);
    equal(a.volumeSerialBytes, b.volumeSerialBytes);
    equal(a.linkCount, 2);
    equal(b.linkCount, 2);
  });
  test("missing names fail", () => {
    fails(
      () => binding.inspectChain(path.join(fixture, "absent")),
      "archive_inspection_open_failed",
    );
  });
  test("direct binding rejects invalid input without coercion", () => {
    for (const input of [
      undefined,
      null,
      3,
      {},
      {
        toString() {
          throw new Error("must not run");
        },
      },
    ]) {
      fails(() => binding.inspectChain(input), "archive_inspection_invalid_argument");
    }
    fails(() => binding.inspectChain(), "archive_inspection_invalid_argument");
    fails(() => binding.inspectChain(file, file), "archive_inspection_invalid_argument");
  });
  test("ambiguous and redirected lexical forms fail", () => {
    for (const input of [
      "relative",
      "c:\\test",
      "\\\\server\\share",
      "\\\\?\\C:\\test",
      "C:\\a\\..\\b",
      "C:\\a\\.\\b",
      "C:\\a:stream",
      "C:\\CON",
      "C:\\COM1.txt",
      "C:\\COM\u00b9",
      "C:\\a ",
      "C:\\a.",
      "C:\\a\\",
      "C:\\a\\\\b",
      "C:\\a\u0000b",
      "C:/a",
      "C:\\" + "a".repeat(4097),
    ]) {
      fails(() => binding.inspectChain(input), "archive_inspection_invalid_path");
    }
  });
  test("junction final component and ancestor fail closed", () => {
    const target = path.join(fixture, "target");
    const junction = path.join(fixture, "junction");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "inside.txt"), "synthetic");
    fs.symlinkSync(target, junction, "junction");
    try {
      fails(() => binding.inspectChain(junction), "archive_inspection_reparse_point");
      fails(
        () => binding.inspectChain(path.join(junction, "inside.txt")),
        "archive_inspection_reparse_point",
      );
    } finally {
      fs.unlinkSync(junction);
    }
  });
  test("replacement between calls has distinct identity", () => {
    const replacement = path.join(fixture, "replacement.txt");
    fs.writeFileSync(replacement, "synthetic replacement", { flag: "wx" });
    const old = final(binding.inspectChain(file));
    fs.unlinkSync(file);
    fs.renameSync(replacement, file);
    const current = final(binding.inspectChain(file));
    ok(old.fileId128 !== current.fileId128);
    equal(current.linkCount, 1);
  });
  console.log(
    JSON.stringify(
      {
        schema: "archive-inspection-unit-report-1",
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cases: results.length,
        assertions,
        results,
        limits: [
          "No atomic traversal claim",
          "No ACL policy or access decision",
          "No durability checks",
          "No runtime enablement",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  // Do not emit private owner/DACL values from assertion diagnostics.
  console.error(
    JSON.stringify({
      passed: false,
      completedCases: results.length,
      code: typeof error.code === "string" ? error.code : "unit_check_failed",
    }),
  );
  process.exitCode = 1;
} finally {
  // Fixed owned fixture; remove the junction above before recursive cleanup.
  fs.rmSync(fixture, { recursive: true, force: true });
}
