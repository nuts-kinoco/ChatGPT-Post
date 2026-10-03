/** Host-startup consistency checks under the trusted host/admin/Node-loader TCB.
 * This is a fixed preinstalled callable registry, not runtime attestation or a module loader.
 * Administrators deploy new versioned bundles; replacing a bundle in place is unsupported.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "../contracts/raw-bytes.js";
import { exactObject } from "./brief.js";
import {
  hostedImportGraphBytes,
  MAX_HOSTED_BUILD_MANIFEST_BYTES,
  parseHostedBuildManifest,
} from "./hosted-build.js";
import {
  HOSTED_BUILD_GRAPH_PATH,
  HOSTED_BUILD_MANIFEST_PATH,
  HOSTED_CONSTANT_MANIFEST_PATH,
} from "./hosted-build-spec.js";
import {
  freezeHostedJson,
  HOSTED_SHA256,
  MAX_PRODUCTION_PROFILE_BYTES,
  type ProductionPromptProfile,
  parseProductionPromptProfile,
  productionConstantManifestBytes,
} from "./production-profile.js";

const INSTALLED_ROOT = fileURLToPath(new URL("../../", import.meta.url));
declare const verifiedHostedRenderer: unique symbol;
export interface VerifiedHostedRenderer {
  readonly kind: "verified-hosted-renderer-1";
  readonly [verifiedHostedRenderer]: true;
}
export interface HostedRendererIdentity {
  readonly rendererId: "bridge-hosted-prompt-1";
  readonly rendererVersion: 1;
  readonly rendererArtifactSha256: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileSha256: string;
  readonly agentId: "chatgpt-browser";
  readonly modelId: "gpt-5.6-sol" | "gpt-5.5";
  readonly routeId: "ordinary_chat_browser";
  readonly codec: "bridge-task-brief-1";
  readonly contextMode: "none";
  readonly outputParser: "response-frame-1+artifact-declaration-1";
  readonly cacheControls: "none";
  readonly policySnapshotSha256: string;
  readonly profile: ProductionPromptProfile;
}
const handles = new WeakMap<VerifiedHostedRenderer, HostedRendererIdentity>();
/** Ordinary bounded reads of fixed registered paths. No task-derived path reaches this function. */
function installedBytes(path: string, maximum: number): Uint8Array {
  let parent = INSTALLED_ROOT;
  const root = lstatSync(parent);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("hosted_build_alias");
  for (const segment of path.split("/").slice(0, -1)) {
    parent = join(parent, segment);
    const directory = lstatSync(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("hosted_build_alias");
  }
  const filename = join(INSTALLED_ROOT, path);
  const before = lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum)
    throw new Error("hosted_build_file_invalid");
  if (realpathSync(filename) !== join(realpathSync(INSTALLED_ROOT), path))
    throw new Error("hosted_build_alias");
  const descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > maximum ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      throw new Error("hosted_build_file_changed");
    const raw = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      raw.byteLength > maximum ||
      raw.byteLength !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new Error("hosted_build_file_changed");
    return raw;
  } finally {
    closeSync(descriptor);
  }
}
function verifyInstalledBuild(expectedSha256: string): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error("hosted_runtime_unsupported");
  // The administrator's configured Node loader is explicitly part of the host TCB.
  // The closed manifest and startup registration require an empty loader declaration;
  // inspecting process flags would not attest which code the host actually loaded.
  const manifestRaw = installedBytes(HOSTED_BUILD_MANIFEST_PATH, MAX_HOSTED_BUILD_MANIFEST_BYTES);
  if (sha256Bytes(manifestRaw) !== expectedSha256) throw new Error("hosted_build_digest_mismatch");
  const manifest = parseHostedBuildManifest(manifestRaw);
  for (const entry of manifest.files) {
    const bytes = installedBytes(entry.path, entry.sizeBytes);
    if (bytes.byteLength !== entry.sizeBytes || sha256Bytes(bytes) !== entry.sha256)
      throw new Error("hosted_build_file_mismatch");
    if (
      entry.path === HOSTED_BUILD_GRAPH_PATH &&
      !Buffer.from(bytes).equals(hostedImportGraphBytes())
    )
      throw new Error("hosted_build_graph_mismatch");
    if (
      entry.path === HOSTED_CONSTANT_MANIFEST_PATH &&
      !Buffer.from(bytes).equals(productionConstantManifestBytes())
    )
      throw new Error("hosted_build_constants_mismatch");
  }
}
export interface VerifyInstalledHostedRendererInput {
  profileRaw: Uint8Array;
  profileSha256: string;
  rendererArtifactSha256: string;
  policySnapshotSha256: string;
  additionalLoaders?: readonly [];
}
/** Called only by trusted host installation/startup with recipient-owned registration.
 * A remote digest or a plain object cannot construct a handle. No user-selected roots,
 * module names, implementation callbacks, downloads or code evaluation are supported.
 */
export function verifyInstalledHostedRenderer(
  input: VerifyInstalledHostedRendererInput,
): VerifiedHostedRenderer {
  exactObject(input, [
    "profileRaw",
    "profileSha256",
    "rendererArtifactSha256",
    "policySnapshotSha256",
    ...(Object.hasOwn(input, "additionalLoaders") ? ["additionalLoaders"] : []),
  ]);
  if (
    (input.additionalLoaders !== undefined &&
      (!Array.isArray(input.additionalLoaders) || input.additionalLoaders.length !== 0)) ||
    !(input.profileRaw instanceof Uint8Array) ||
    input.profileRaw.byteLength > MAX_PRODUCTION_PROFILE_BYTES ||
    ![input.profileSha256, input.rendererArtifactSha256, input.policySnapshotSha256].every(
      (value) => typeof value === "string" && HOSTED_SHA256.test(value),
    )
  )
    throw new Error("hosted_registration_invalid");
  const raw = Uint8Array.from(input.profileRaw);
  const profile = parseProductionPromptProfile(raw);
  if (sha256Bytes(raw) !== input.profileSha256) throw new Error("hosted_profile_digest_mismatch");
  verifyInstalledBuild(input.rendererArtifactSha256);
  const identity: HostedRendererIdentity = freezeHostedJson({
    rendererId: profile.rendererId,
    rendererVersion: profile.rendererVersion,
    rendererArtifactSha256: input.rendererArtifactSha256,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    profileSha256: input.profileSha256,
    agentId: profile.agentId,
    modelId: profile.modelId,
    routeId: profile.routeId,
    codec: profile.codec,
    contextMode: profile.contextMode,
    outputParser: profile.outputGrammar.parser,
    cacheControls: profile.cacheControls,
    policySnapshotSha256: input.policySnapshotSha256,
    profile,
  });
  const handle = Object.freeze({
    kind: "verified-hosted-renderer-1" as const,
  }) as VerifiedHostedRenderer;
  handles.set(handle, identity);
  return handle;
}
export function assertVerifiedHostedRenderer(handle: VerifiedHostedRenderer): void {
  if (!handles.has(handle)) throw new Error("hosted_renderer_unavailable");
}
export function hostedRendererIdentity(handle: VerifiedHostedRenderer): HostedRendererIdentity {
  const identity = handles.get(handle);
  if (!identity) throw new Error("hosted_renderer_unavailable");
  return identity;
}
/** Optional startup/admission/history refresh. Never re-renders or permits a retry. */
export function reverifyInstalledHostedRenderer(handle: VerifiedHostedRenderer): void {
  verifyInstalledBuild(hostedRendererIdentity(handle).rendererArtifactSha256);
}
/** Trusted deployment revocation invalidates all future uses of this exact handle. */
export function revokeHostedRenderer(handle: VerifiedHostedRenderer): void {
  handles.delete(handle);
}
export const getHostedRendererInfo = hostedRendererIdentity;
