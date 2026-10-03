/* biome-ignore-all lint/style/noNonNullAssertion: The port is checked before the bounded adapter callback is constructed. */
/** Thin authenticated UI adapter over the host's canonical archiveOperations helper. */

import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type OperationBinding,
  type OperationDetail,
  validateOperationsMutation,
} from "../contracts/operations.js";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
import { UiError } from "../contracts/ui.js";
import type { UiOperationsService } from "./operations.js";
export interface UiArchivePort {
  inspect(requestId: string): unknown | Promise<unknown>;
  collect?(requestId: string): unknown | Promise<unknown>;
  exportDiagnostics(
    requestId: string,
  ):
    | { bytes: Uint8Array; sha256: string; contentSha256: string }
    | Promise<{ bytes: Uint8Array; sha256: string; contentSha256: string }>;
  probe(
    root: string,
  ): { writable: boolean; cleaned: boolean } | Promise<{ writable: boolean; cleaned: boolean }>;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new UiError("archive_view_invalid", "Archive metadata failed validation", 409);
  return value as Record<string, unknown>;
}
async function archiveCall<T>(call: () => T | Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const reasons: Record<string, string> = {
      archive_windows_storage_unimplemented:
        "Windows storage identity/ACL support is not implemented; this archive operation is disabled",
      archive_path_not_owned: "The output root ownership/identity check failed",
      archive_root_invalid: "The configured output root is invalid",
      archive_file_unsafe: "The archive contains an unsafe file identity",
      archive_path_escape: "The archive path escaped its registered root",
      archive_legacy_admission_unpinned: "This old job has no immutable archive admission pin",
    };
    if (Object.hasOwn(reasons, code))
      throw new UiError(code, reasons[code] ?? "Archive operation unavailable", 409);
    throw new UiError(
      "archive_operation_unavailable",
      "Archive operation failed safely; check the configured provider and diagnostic record",
      409,
    );
  }
}
export class UiArchiveApi {
  constructor(
    private readonly operations: UiOperationsService,
    private readonly port: UiArchivePort | undefined,
  ) {}
  capability() {
    return {
      enabled: !!this.port,
      collectEnabled: typeof this.port?.collect === "function",
      reason: this.port
        ? "Archive helper is configured; exact job binding is checked for each operation"
        : "Trusted archive helper is unconfigured",
    };
  }
  private async bound(input: unknown): Promise<{
    binding: OperationBinding;
    operation: Exclude<OperationDetail, { kind: "fanout" }>;
  }> {
    const value = object(input);
    if (Object.keys(value).sort().join() !== "binding,version")
      throw new UiError(
        "invalid_archive_binding",
        "Only version and exact job binding are accepted",
      );
    const mutation = { ...value, action: "archive" };
    validateOperationsMutation(mutation);
    const binding = mutation.binding;
    const read = await this.operations.detail(binding.kind, binding.requestId);
    if (read.state !== "available" || read.value.kind === "fanout")
      throw new UiError("archive_job_unavailable", "The bound job could not be inspected", 409);
    if (!isDeepStrictEqual(read.value.binding, binding))
      throw new UiError("stale_archive_binding", "Job binding changed; refresh before acting", 409);
    return { binding, operation: read.value };
  }
  async inspect(input: unknown) {
    if (!this.port)
      throw new UiError("archive_unconfigured", "Trusted archive helper is unconfigured", 409);
    const { binding, operation } = await this.bound(input),
      inspection = object(await archiveCall(() => this.port!.inspect(binding.requestId))),
      pin = object(inspection.pin);
    if (
      inspection.schema !== "archive-inspection-2" ||
      pin.requestId !== binding.requestId ||
      !["not_archived", "complete", "incomplete", "unavailable", "corrupt"].includes(
        String(inspection.state),
      )
    )
      throw new UiError("archive_view_invalid", "Archive identity or state is invalid", 409);
    const manifest = inspection.manifest === null ? null : object(inspection.manifest);
    let items: unknown[] = [];
    if (manifest) {
      const admission = object(manifest.admission),
        route = object(admission.route),
        payload = object(manifest.payload);
      const expected =
        operation.kind === "local_execution"
          ? operation.task.delivery.payloadSha256
          : operation.terminal?.payloadSha256;
      if (
        manifest.schema !== "artifact-archive-2" ||
        admission.requestId !== binding.requestId ||
        admission.taskSpecHash !== binding.taskSpecHash ||
        route.kind !== binding.kind ||
        !expected ||
        payload.contentSha256 !== expected ||
        !Array.isArray(manifest.items) ||
        manifest.items.length > 64
      )
        throw new UiError(
          "archive_payload_mismatch",
          "Archive does not match the bound terminal result",
          409,
        );
      items = manifest.items.map((item) => {
        const value = object(item);
        return {
          artifactId: value.artifactId,
          logicalName: value.logicalName,
          filename: value.filename,
          required: value.required === true,
          contentSha256: value.contentSha256,
          sizeBytes: value.sizeBytes,
          state: value.state,
          unavailableReason: value.unavailableReason,
        };
      });
    }
    return {
      version: "bridge-artifact-view-1",
      binding,
      state: inspection.state,
      manifestSha256: inspection.manifestSha256,
      issue: inspection.issue,
      pinnedRoot: pin.localPinnedRoot,
      relativeDirectory: pin.relativeDirectory,
      registryRevision: pin.registryRevision,
      projectId: pin.projectId,
      requiredSetKnown: manifest?.requiredSetKnown === true,
      complete: manifest?.complete === true,
      synthetic: manifest?.synthetic === true,
      items,
      reexecute: false,
    };
  }
  async collect(input: unknown) {
    if (!this.port?.collect)
      throw new UiError("archive_collect_unconfigured", "Archive collection is unavailable", 409);
    const { binding } = await this.bound(input);
    await archiveCall(() => this.port!.collect!(binding.requestId));
    const refreshed = await this.operations.detail(binding.kind, binding.requestId);
    if (refreshed.state !== "available" || refreshed.value.kind === "fanout")
      throw new UiError(
        "archive_job_unavailable",
        "Collection returned but job binding could not be refreshed",
        409,
      );
    return this.inspect({ version: "bridge-operations-1", binding: refreshed.value.binding });
  }
  async export(input: unknown) {
    if (!this.port)
      throw new UiError("archive_unconfigured", "Trusted archive helper is unconfigured", 409);
    const { binding } = await this.bound(input),
      result = await archiveCall(() => this.port!.exportDiagnostics(binding.requestId));
    if (result.bytes.length > 2 * 1024 * 1024 || sha256Bytes(result.bytes) !== result.sha256)
      throw new UiError(
        "diagnostic_export_invalid",
        "Sanitized diagnostic export failed integrity validation",
        409,
      );
    const content = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
    const envelope = object(parseStrictJsonBytes(result.bytes));
    if (
      envelope.content_sha256 !== result.contentSha256 ||
      sha256Bytes(Buffer.from(JSON.stringify(envelope.content))) !== result.contentSha256
    )
      throw new UiError(
        "diagnostic_export_invalid",
        "Diagnostic content digest did not match",
        409,
      );
    if (
      !["bridge-diagnostic-2", "bridge-sanitized-diagnostics-1"].includes(String(envelope.schema))
    )
      throw new UiError("diagnostic_export_invalid", "Unknown sanitized diagnostic schema", 409);
    return {
      version: "bridge-diagnostic-download-1",
      filename: "bridge-sanitized-diagnostics.json",
      sha256: result.sha256,
      contentSha256: result.contentSha256,
      content,
    };
  }
  async probe(input: unknown) {
    if (!this.port)
      throw new UiError("archive_unconfigured", "Trusted archive helper is unconfigured", 409);
    const value = object(input);
    if (
      Object.keys(value).join() !== "root" ||
      typeof value.root !== "string" ||
      value.root.length > 4096 ||
      /[\0\r\n]/.test(value.root) ||
      !(isAbsolute(value.root) || /^[A-Za-z]:[\\/]/.test(value.root))
    )
      throw new UiError("archive_probe_invalid", "An explicit absolute local root is required");
    const result = await archiveCall(() => this.port!.probe(value.root as string));
    if (!result.writable || !result.cleaned)
      throw new UiError(
        "archive_probe_failed",
        "Root probe did not confirm write and cleanup",
        409,
      );
    return {
      version: "bridge-root-probe-1",
      writable: true,
      cleaned: true,
      scope: "explicit-root-only",
      executionAuthority: false,
    };
  }
}

/** Projection of the same canonical helper, never a mirrored archive/settings store. */
export function archiveOperationsSource(
  port: UiArchivePort,
  collect: (binding: OperationBinding) => Promise<unknown>,
): NonNullable<import("./operations.js").UiOperationsSources["archive"]> {
  return {
    async read(binding) {
      const inspection = object(await archiveCall(() => port.inspect(binding.requestId))),
        pin = object(inspection.pin);
      if (pin.requestId !== binding.requestId) throw new Error("archive_binding_mismatch");
      const manifest = inspection.manifest === null ? null : object(inspection.manifest);
      if (manifest) {
        const admission = object(manifest.admission);
        if (
          admission.requestId !== binding.requestId ||
          admission.taskSpecHash !== binding.taskSpecHash ||
          object(admission.route).kind !== binding.kind
        )
          throw new Error("archive_binding_mismatch");
      }
      return {
        state:
          inspection.state === "complete"
            ? "complete"
            : inspection.state === "not_archived" || inspection.state === "incomplete"
              ? "pending"
              : "unavailable",
        manifestSha256:
          typeof inspection.manifestSha256 === "string" ? inspection.manifestSha256 : null,
        admissionSha256: typeof pin.admissionHash === "string" ? pin.admissionHash : null,
        reason:
          inspection.state === "complete"
            ? null
            : typeof inspection.issue === "string"
              ? inspection.issue
              : "archive_not_complete",
      };
    },
    ...(port.collect
      ? {
          collect: async (binding: OperationBinding) => {
            await collect(binding);
          },
        }
      : {}),
  };
}
