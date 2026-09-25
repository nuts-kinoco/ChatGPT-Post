import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("portable build unpacks each launch into its own directory", async () => {
  // A fixed unpack dir (electron-builder's default build-time KSUID) is wiped by the portable stub's
  // `RMDir /r` when the exe is launched again, deleting icudtl.dat from under the running instance.
  // electron-builder only skips the fixed name for `true` (its docs say `false`, but `false` falls back to the KSUID).
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.build.portable.unpackDirName, true);
});
