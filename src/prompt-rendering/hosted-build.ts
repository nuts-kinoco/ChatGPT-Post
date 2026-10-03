/** Canonical manifest codec for the one reviewed, closed preinstalled implementation. */
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/raw-bytes.js";
import { exactObject } from "./brief.js";
import {
  HOSTED_BUILD_BUILTINS,
  HOSTED_BUILD_ENTRYPOINT,
  HOSTED_BUILD_FILES,
  HOSTED_BUILD_IMPORTS,
} from "./hosted-build-spec.js";
import { freezeHostedJson, HOSTED_SHA256 } from "./production-profile.js";

export const MAX_HOSTED_BUILD_MANIFEST_BYTES = 1024 * 1024;
export interface HostedBuildFile {
  path: string;
  kind: "javascript" | "json" | "fixed_text";
  sha256: string;
  sizeBytes: number;
}
export interface HostedBuildManifest {
  schema: "bridge-renderer-build-manifest-1";
  rendererId: "bridge-hosted-prompt-1";
  rendererVersion: 1;
  entrypoint: string;
  runtime: { kind: "node"; compatibilityProfile: "bridge-node-runtime-1"; additionalLoaders: [] };
  importGraphSha256: string;
  builtinModules: string[];
  files: HostedBuildFile[];
}
function validPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= 512 &&
    /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*(?![\s\S])/.test(path) &&
    path
      .split("/")
      .every(
        (segment) =>
          !segment.endsWith(".") && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment),
      )
  );
}
export function hostedImportGraphBytes(): Uint8Array {
  return Buffer.from(`${JSON.stringify(HOSTED_BUILD_IMPORTS)}\n`);
}
export function parseHostedBuildManifest(raw: Uint8Array): HostedBuildManifest {
  if (
    !(raw instanceof Uint8Array) ||
    raw.byteLength === 0 ||
    raw.byteLength > MAX_HOSTED_BUILD_MANIFEST_BYTES
  )
    throw new Error("hosted_build_manifest_size_invalid");
  const row = exactObject(parseStrictJsonBytes(raw), [
    "schema",
    "rendererId",
    "rendererVersion",
    "entrypoint",
    "runtime",
    "importGraphSha256",
    "builtinModules",
    "files",
  ]);
  const runtime = exactObject(row.runtime, ["kind", "compatibilityProfile", "additionalLoaders"]);
  if (
    row.schema !== "bridge-renderer-build-manifest-1" ||
    row.rendererId !== "bridge-hosted-prompt-1" ||
    row.rendererVersion !== 1 ||
    row.entrypoint !== HOSTED_BUILD_ENTRYPOINT ||
    runtime.kind !== "node" ||
    runtime.compatibilityProfile !== "bridge-node-runtime-1" ||
    !Array.isArray(runtime.additionalLoaders) ||
    runtime.additionalLoaders.length !== 0 ||
    typeof row.importGraphSha256 !== "string" ||
    !HOSTED_SHA256.test(row.importGraphSha256) ||
    row.importGraphSha256 !== sha256Bytes(hostedImportGraphBytes()) ||
    !Array.isArray(row.builtinModules) ||
    row.builtinModules.length > 32 ||
    JSON.stringify(row.builtinModules) !== JSON.stringify(HOSTED_BUILD_BUILTINS) ||
    !Array.isArray(row.files) ||
    row.files.length < 1 ||
    row.files.length > 4096
  )
    throw new Error("hosted_build_manifest_invalid");
  let total = 0;
  const files: HostedBuildFile[] = row.files.map((entry) => {
    const file = exactObject(entry, ["path", "kind", "sha256", "sizeBytes"]);
    if (
      !validPath(file.path) ||
      !["javascript", "json", "fixed_text"].includes(file.kind as string) ||
      typeof file.sha256 !== "string" ||
      !HOSTED_SHA256.test(file.sha256) ||
      typeof file.sizeBytes !== "number" ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      file.sizeBytes > 16 * 1024 * 1024
    )
      throw new Error("hosted_build_file_invalid");
    total += file.sizeBytes;
    if (total > 256 * 1024 * 1024) throw new Error("hosted_build_total_too_large");
    const expectedKind = file.path.endsWith(".js") ? "javascript" : "json";
    if (file.kind !== expectedKind) throw new Error("hosted_build_file_invalid");
    return { path: file.path, kind: expectedKind, sha256: file.sha256, sizeBytes: file.sizeBytes };
  });
  if (JSON.stringify(files.map((file) => file.path)) !== JSON.stringify(HOSTED_BUILD_FILES))
    throw new Error("hosted_build_closed_set_mismatch");
  const manifest: HostedBuildManifest = {
    schema: "bridge-renderer-build-manifest-1",
    rendererId: "bridge-hosted-prompt-1",
    rendererVersion: 1,
    entrypoint: HOSTED_BUILD_ENTRYPOINT,
    runtime: { kind: "node", compatibilityProfile: "bridge-node-runtime-1", additionalLoaders: [] },
    importGraphSha256: row.importGraphSha256,
    builtinModules: [...HOSTED_BUILD_BUILTINS],
    files,
  };
  if (!Buffer.from(raw).equals(Buffer.from(`${JSON.stringify(manifest)}\n`)))
    throw new Error("hosted_build_manifest_noncanonical");
  return freezeHostedJson(manifest);
}
