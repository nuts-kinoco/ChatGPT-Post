/** Explicitly configured delivery CAS. Configuration is trusted host input, never task JSON.
 * A Git destination grants no implicit sharing authority, including for raw artifacts. This
 * adapter does not create a repository, obtain credentials, resolve URLs, or read local paths.
 */
import {
  type GitObjectStore,
  type GitSnapshot,
  gitBlobSha,
  transportPath,
} from "../adapters/github-client.js";
import {
  type DeliveryBindingV1,
  type DeliveryContentAddressV1,
  MAX_DELIVERY_MANIFEST_BYTES,
  validateDeliveryBindingV1,
  validateDeliveryContentAddressV1,
} from "../contracts/materialization.js";
import { sha256Bytes } from "../contracts/task.js";
import type { ContentAddressedDeliveryReaderV1 } from "./materializer.js";
import { MAX_ARCHIVE_FILE_BYTES } from "./paths.js";

export type DeliveryContentPurposeV1 = "signed_delivery_manifest" | "terminal_payload" | "artifact";
export interface DeliveryContentScopeV1 {
  binding: DeliveryBindingV1;
  purpose: DeliveryContentPurposeV1;
  artifactId: string | null;
}
/** Exact, immutable host-authorized scope. No wildcards or allow-by-destination shortcuts.
 * The content hash also prevents a scoped caller from fetching another request's known CAS hash.
 * Read authority and publication authority must each be explicitly granted.
 */
export interface DeliveryContentAuthorizationV1 extends DeliveryContentScopeV1 {
  operation: "read" | "publish";
  destinationId: string;
  contentSha256: string;
}
export interface ConfiguredGitDeliveryDestinationV1 {
  destinationId: string;
  /** Trusted host dependency: append must implement atomic, append-only CAS, as GitHubGitStore
   * does. Preflight and readback reject detectable corruption but cannot confer that property on
   * a dishonest store or stop an in-flight operation through this non-cancellable interface.
   */
  store: GitObjectStore;
  namespace: string;
  maxBytes: number;
  /** Total deadline for one operation, including all snapshots, reads, and publication readback. */
  timeoutMs: number;
  maxFiles: number;
}
export interface ConfiguredGitDeliveryContentStoreOptionsV1 {
  destinations: readonly ConfiguredGitDeliveryDestinationV1[];
  authorizations?: readonly DeliveryContentAuthorizationV1[];
}
export interface DeliveryContentPublicationV1 extends DeliveryContentScopeV1 {
  destinationId: string;
  bytes: Uint8Array;
}
export interface ContentAddressedDeliveryPublicationPortV1 {
  /** Explicit publication only. The returned address means exact bytes were read back and verified;
   * it does not attest requester materialization, execution success, or transport ACK.
   */
  publish(input: DeliveryContentPublicationV1): Promise<DeliveryContentAddressV1>;
}
export class DeliveryContentStoreError extends Error {}

const ID = /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/;
const ARTIFACT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}(?![\s\S])/;
const GIT_SHA = /^[a-f0-9]{40}(?![\s\S])/;
const MAX_TIMEOUT_MS = 120_000;
const MAX_FILES = 100_000;
const MAX_AUTHORIZATIONS = 10_000;

function fail(code: string): never {
  throw new DeliveryContentStoreError(code);
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail("delivery_content_configuration_invalid");
  return value as Record<string, unknown>;
}
function positiveInteger(value: unknown, maximum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}
function scope(value: DeliveryContentScopeV1): DeliveryContentScopeV1 {
  const binding = validateDeliveryBindingV1(value.binding);
  if (
    !["signed_delivery_manifest", "terminal_payload", "artifact"].includes(value.purpose) ||
    (value.purpose === "artifact"
      ? typeof value.artifactId !== "string" || !ARTIFACT_ID.test(value.artifactId)
      : value.artifactId !== null)
  )
    fail("delivery_content_scope_invalid");
  return { binding, purpose: value.purpose, artifactId: value.artifactId };
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
function checkedAuthorization(
  value: DeliveryContentAuthorizationV1,
): DeliveryContentAuthorizationV1 {
  exact(value, ["operation", "destinationId", "contentSha256", "binding", "purpose", "artifactId"]);
  if (value.operation !== "read" && value.operation !== "publish")
    fail("delivery_content_configuration_invalid");
  const address = validateDeliveryContentAddressV1({
    destinationId: value.destinationId,
    contentSha256: value.contentSha256,
  });
  const allowedScope = scope(value);
  if (
    allowedScope.purpose === "terminal_payload" &&
    address.contentSha256 !== allowedScope.binding.payloadSha256
  )
    fail("delivery_content_scope_invalid");
  return { operation: value.operation, ...address, ...allowedScope };
}
function sizeLimit(
  destination: ConfiguredGitDeliveryDestinationV1,
  purpose: DeliveryContentPurposeV1,
) {
  return Math.min(
    destination.maxBytes,
    purpose === "signed_delivery_manifest" ? MAX_DELIVERY_MANIFEST_BYTES : MAX_ARCHIVE_FILE_BYTES,
  );
}
/** Each await is bounded by a single monotonic operation deadline. GitObjectStore has no abort
 * port: an in-flight append may finish after timeout, so that outcome remains unknown. We never
 * continue to another I/O after expiration, retry internally, overwrite, or report durable success.
 */
async function bounded<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) fail("delivery_content_timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (performance.now() >= deadline) fail("delivery_content_timeout");
        return operation();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DeliveryContentStoreError("delivery_content_timeout")),
          remaining,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class ConfiguredGitDeliveryContentStoreV1
  implements ContentAddressedDeliveryReaderV1, ContentAddressedDeliveryPublicationPortV1
{
  private readonly destinations = new Map<string, ConfiguredGitDeliveryDestinationV1>();
  private readonly grants = new Set<string>();

  constructor(options: ConfiguredGitDeliveryContentStoreOptionsV1) {
    if (
      !options ||
      !Array.isArray(options.destinations) ||
      options.destinations.length > 128 ||
      (options.authorizations !== undefined && !Array.isArray(options.authorizations)) ||
      (options.authorizations?.length ?? 0) > MAX_AUTHORIZATIONS
    )
      fail("delivery_content_configuration_invalid");
    for (const destination of options.destinations) {
      exact(destination, [
        "destinationId",
        "store",
        "namespace",
        "maxBytes",
        "timeoutMs",
        "maxFiles",
      ]);
      if (
        typeof destination.destinationId !== "string" ||
        !ID.test(destination.destinationId) ||
        this.destinations.has(destination.destinationId) ||
        typeof destination.namespace !== "string" ||
        destination.namespace.length > 400 ||
        !positiveInteger(destination.maxBytes, MAX_ARCHIVE_FILE_BYTES) ||
        !positiveInteger(destination.timeoutMs, MAX_TIMEOUT_MS) ||
        !positiveInteger(destination.maxFiles, MAX_FILES) ||
        !destination.store ||
        typeof destination.store.snapshot !== "function" ||
        typeof destination.store.read !== "function" ||
        typeof destination.store.append !== "function"
      )
        fail("delivery_content_configuration_invalid");
      try {
        transportPath(destination.namespace);
        transportPath(`${destination.namespace}/cas/sha256/00/${"0".repeat(64)}`);
      } catch {
        fail("delivery_content_configuration_invalid");
      }
      // Copy configuration so a caller cannot later repoint an approved destination or broaden limits.
      this.destinations.set(destination.destinationId, { ...destination });
    }
    for (const grant of options.authorizations ?? []) {
      const checked = checkedAuthorization(grant);
      if (!this.destinations.has(checked.destinationId))
        fail("delivery_content_destination_denied");
      this.grants.add(canonical(checked));
    }
  }

  private authorize(grant: DeliveryContentAuthorizationV1): ConfiguredGitDeliveryDestinationV1 {
    const checked = checkedAuthorization(grant);
    const destination = this.destinations.get(checked.destinationId);
    if (!destination) fail("delivery_content_destination_denied");
    if (!this.grants.has(canonical(checked))) fail("delivery_content_scope_denied");
    return destination;
  }

  private path(destination: ConfiguredGitDeliveryDestinationV1, contentSha256: string): string {
    return `${destination.namespace}/cas/sha256/${contentSha256.slice(0, 2)}/${contentSha256}`;
  }

  private async snapshot(destination: ConfiguredGitDeliveryDestinationV1, deadline: number) {
    const snapshot = await bounded(deadline, () => destination.store.snapshot());
    if (
      !snapshot ||
      typeof snapshot.commit !== "string" ||
      typeof snapshot.tree !== "string" ||
      !GIT_SHA.test(snapshot.commit) ||
      !GIT_SHA.test(snapshot.tree) ||
      !(snapshot.files instanceof Map) ||
      snapshot.files.size > destination.maxFiles
    )
      fail("delivery_content_snapshot_invalid");
    const files = new Map<string, string>();
    for (const [path, sha] of snapshot.files) {
      if (typeof path !== "string" || typeof sha !== "string" || !GIT_SHA.test(sha))
        fail("delivery_content_snapshot_invalid");
      try {
        transportPath(path);
      } catch {
        fail("delivery_content_snapshot_invalid");
      }
      files.set(path, sha);
    }
    return { commit: snapshot.commit, tree: snapshot.tree, files };
  }

  private async readVerified(
    destination: ConfiguredGitDeliveryDestinationV1,
    snapshot: GitSnapshot,
    address: DeliveryContentAddressV1,
    maxBytes: number,
    deadline: number,
  ): Promise<Uint8Array | null> {
    const path = this.path(destination, address.contentSha256);
    const expectedGitSha = snapshot.files.get(path);
    const response = await bounded(deadline, () => destination.store.read(snapshot, path));
    if (response === null && expectedGitSha === undefined) return null;
    if (!(response instanceof Uint8Array)) fail("delivery_content_unavailable");
    // GitHubGitStore bounds streamed responses; enforce independent post-read limits on any port.
    if (response.byteLength > maxBytes) fail("delivery_content_size_limit");
    const bytes = Uint8Array.from(response);
    if (sha256Bytes(bytes) !== address.contentSha256) fail("delivery_content_hash_mismatch");
    if (expectedGitSha === undefined || gitBlobSha(bytes) !== expectedGitSha)
      fail("delivery_content_snapshot_mismatch");
    return bytes;
  }

  async read(
    source: DeliveryContentAddressV1,
    context: DeliveryContentScopeV1 & { maxBytes: number },
  ): Promise<Uint8Array | null> {
    const address = validateDeliveryContentAddressV1(source);
    exact(context, ["binding", "purpose", "artifactId", "maxBytes"]);
    const requestScope = scope(context);
    if (
      typeof context.maxBytes !== "number" ||
      !Number.isSafeInteger(context.maxBytes) ||
      context.maxBytes < 0 ||
      context.maxBytes > MAX_ARCHIVE_FILE_BYTES
    )
      fail("delivery_content_size_limit");
    const destination = this.authorize({ operation: "read", ...address, ...requestScope });
    const deadline = performance.now() + destination.timeoutMs;
    const maxBytes = Math.min(context.maxBytes, sizeLimit(destination, requestScope.purpose));
    const snapshot = await this.snapshot(destination, deadline);
    return this.readVerified(destination, snapshot, address, maxBytes, deadline);
  }

  async publish(input: DeliveryContentPublicationV1): Promise<DeliveryContentAddressV1> {
    exact(input, ["destinationId", "bytes", "binding", "purpose", "artifactId"]);
    const requestScope = scope(input);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > MAX_ARCHIVE_FILE_BYTES)
      fail("delivery_content_size_limit");
    const bytes = Uint8Array.from(input.bytes);
    const address = validateDeliveryContentAddressV1({
      destinationId: input.destinationId,
      contentSha256: sha256Bytes(bytes),
    });
    const destination = this.authorize({ operation: "publish", ...address, ...requestScope });
    const maxBytes = sizeLimit(destination, requestScope.purpose);
    if (bytes.byteLength > maxBytes) fail("delivery_content_size_limit");
    const deadline = performance.now() + destination.timeoutMs;
    const before = await this.snapshot(destination, deadline);
    const path = this.path(destination, address.contentSha256);
    if (before.files.has(path)) {
      const existing = await this.readVerified(destination, before, address, maxBytes, deadline);
      if (!existing || !Buffer.from(existing).equals(bytes))
        fail("delivery_content_immutable_conflict");
      return address;
    }
    if (before.files.size >= destination.maxFiles) fail("delivery_content_snapshot_limit");
    // Only the configured append-only port receives bytes; data-derived strings never form paths.
    // An unresolved write may have committed. Preserve that uncertainty rather than retrying here.
    try {
      const commit = await bounded(deadline, () =>
        destination.store.append(
          new Map([[path, Uint8Array.from(bytes)]]),
          "Publish delivery content",
        ),
      );
      if (typeof commit !== "string" || !GIT_SHA.test(commit))
        fail("delivery_content_publication_unknown");
    } catch {
      fail("delivery_content_publication_unknown");
    }
    const after = await this.snapshot(destination, deadline);
    const stored = await this.readVerified(destination, after, address, maxBytes, deadline);
    if (!stored || !Buffer.from(stored).equals(bytes)) fail("delivery_content_readback_failed");
    return address;
  }
}
