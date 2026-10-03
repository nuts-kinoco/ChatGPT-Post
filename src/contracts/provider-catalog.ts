/** Read-only discovery views. Neither an execution registry nor a model/policy grant. */
export type CatalogReason =
  | "none"
  | "auth_required"
  | "format_unverified"
  | "unavailable"
  | "timeout"
  | "output_limit"
  | "process_failed"
  | "malformed_output"
  | "version_unsupported"
  | "binary_untrusted"
  | "ambiguous"
  | "incomplete"
  | "context_changed"
  | "clock_rollback";
export interface ProviderCatalogScope {
  providerId: string;
  routeId: string;
  /** Trusted host identity for the observation context; never a credential or inferred account. */
  contextId: string;
  revision: { kind: "cli_binary" | "dom_profile"; id: string; version: string };
}
export interface ProviderCatalogOption {
  /** Catalog-scoped row identity; MUST NOT be promoted to a provider model ID. */
  observationKey: string;
  label: string;
  providerModelId: string | null;
  identitySource: "provider_reported" | "unverified_label";
  checked: boolean | null;
  enabled: boolean | null;
  ambiguity: "none" | "duplicate_label" | "duplicate_id" | "unknown";
  effort: { scope: "model_reported" | "unknown"; values: string[]; source: string | null };
}
export interface ProviderCatalogSnapshot {
  schema: "bridge-provider-catalog-1";
  scope: ProviderCatalogScope;
  observedAt: string;
  source: {
    kind: "cli_metadata" | "browser_dom";
    operation: string;
    formatId: string;
    contentSha256: string | null;
  };
  complete: boolean;
  reason: CatalogReason;
  options: ProviderCatalogOption[];
  /** CLI syntax only. It never means every model supports these effort values. */
  effortSyntax: { scope: "cli_global" | "unknown"; values: string[]; source: string | null };
  accountAvailability: "unknown";
  cost: "unknown";
  executionAuthorized: false;
}
export interface ProviderCatalogView {
  schema: "bridge-provider-catalog-cache-1";
  scope: ProviderCatalogScope;
  catalog: ProviderCatalogSnapshot | null;
  fetchedAt: string | null;
  expiresAt: string | null;
  stale: boolean;
  state: "fresh" | "stale" | "unknown";
  refresh: {
    lastAttemptAt: string | null;
    nextAllowedAt: string | null;
    error: CatalogReason | null;
    /** Remains true after timeout until the owned process actually exits. */
    ownershipHeld: boolean;
  };
}
