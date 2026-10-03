/** Actual metadata command adapter; until successful output grammar is verified, model IDs stay unknown. */

import type {
  ProviderCatalogScope,
  ProviderCatalogSnapshot,
} from "../contracts/provider-catalog.js";
import { sha256Bytes } from "../contracts/task.js";
import { type AntigravityCliCapabilities, validateAntigravityCapabilities } from "./antigravity.js";
import type {
  AntigravityMetadataProbe,
  MetadataProbeLease,
  ProbeFailure,
} from "./antigravity-probe.js";
import type { CatalogMetadataSource, CatalogRefreshResult } from "./provider-catalog-cache.js";
export interface AntigravityCatalogOptions {
  /** Names the isolated metadata context, not an inferred logged-in account. */
  contextId: string;
  binarySha256: string;
  capabilities: AntigravityCliCapabilities;
}
export class AntigravityCatalogSource implements CatalogMetadataSource {
  private readonly options: AntigravityCatalogOptions;
  constructor(
    private readonly probe: AntigravityMetadataProbe,
    options: AntigravityCatalogOptions,
  ) {
    this.options = structuredClone(options);
    validateAntigravityCapabilities(options.capabilities, options.capabilities.version);
    if (!options.contextId || !/^[a-f0-9]{64}$/.test(options.binarySha256))
      throw new Error("antigravity_catalog_scope_invalid");
  }
  start(scope: ProviderCatalogScope): MetadataProbeLease<CatalogRefreshResult> {
    const o = this.options;
    if (
      scope.providerId !== "antigravity" ||
      scope.routeId !== "antigravity_cli" ||
      scope.contextId !== o.contextId ||
      scope.revision.kind !== "cli_binary" ||
      scope.revision.id !== o.binarySha256 ||
      scope.revision.version !== o.capabilities.version
    )
      throw new Error("antigravity_catalog_scope_mismatch");
    const lease = this.probe.start("models");
    const failure = (reason: ProbeFailure): CatalogRefreshResult => ({
      kind: "failed",
      reason: reason === "cancelled" || reason === "platform_unsupported" ? "unavailable" : reason,
    });
    const result = lease.result.then((value): CatalogRefreshResult => {
      if (value.kind === "failed") return failure(value.reason);
      if (value.binarySha256 !== o.binarySha256)
        return { kind: "failed", reason: "binary_untrusted" };
      // Do not turn arbitrary lines or display labels into invented provider model IDs.
      const snapshot: ProviderCatalogSnapshot = {
        schema: "bridge-provider-catalog-1",
        scope: structuredClone(scope),
        observedAt: value.observedAt,
        source: {
          kind: "cli_metadata",
          operation: "models",
          formatId: "agy-models-text-unverified/1",
          contentSha256: sha256Bytes(Buffer.from(value.stdout)),
        },
        complete: false,
        reason: "format_unverified",
        options: [],
        effortSyntax: {
          scope: "cli_global",
          values: [...o.capabilities.efforts],
          source: o.capabilities.helpSha256,
        },
        accountAvailability: "unknown",
        cost: "unknown",
        executionAuthorized: false,
      };
      return { kind: "snapshot", snapshot };
    });
    return { result, exited: lease.exited, cancel: () => lease.cancel() };
  }
}
