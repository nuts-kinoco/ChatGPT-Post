#!/usr/bin/env node
/** Explicit offline-only preview. No launcher, bus or provider adapter imports. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { offlinePreviewErrorCode, previewFiles } from "../dist/prompt-rendering/offline-files.js";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5) throw new Error("offline_arguments_invalid");
    const preview = previewFiles(process.argv[2], process.argv[3], process.argv[4]);
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
  } catch (error) {
    // No paths, input content, provider messages or credentials in diagnostics.
    process.stderr.write(`${offlinePreviewErrorCode(error)}\n`);
    process.exitCode = 1;
  }
}
