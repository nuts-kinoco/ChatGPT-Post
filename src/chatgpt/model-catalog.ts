import { createHash } from "node:crypto";
import type {
  ProviderCatalogOption,
  ProviderCatalogSnapshot,
} from "../contracts/provider-catalog.js";
import type { ObservedModel } from "../contracts/types.js";
import { MAX_DOM_CANDIDATES, type ScanReason } from "./dom-observation.js";
import { reverseLookupModel } from "./selectors.js";

export const MODEL_CATALOG_VERSION = "chatgpt-visible-model-catalog-1";
export const MAX_MODEL_LABEL_LENGTH = 512;
export const MAX_PROVIDER_MODEL_ID_LENGTH = 256;

/** Trusted, reviewed code configuration, never learned from page content. */
export interface ModelSelectorProfile {
  version: string;
  providerModelIdAttribute: string | null;
  evidence: ReadonlyArray<{
    kind: "historical_live" | "structural_capture";
    date: string;
    reference: string;
  }>;
}

export const MODEL_SELECTOR_PROFILE: ModelSelectorProfile = {
  version: "chatgpt-picker-2026-09-25-v1",
  // The reviewed radio DOM has text/checked state, no verified provider model ID attribute.
  providerModelIdAttribute: null,
  evidence: [
    { kind: "historical_live", date: "2026-09-15", reference: "modelRadio verifiedOn" },
    {
      kind: "structural_capture",
      date: "2026-09-24",
      reference: "chatgpt-2026-09-24-redesign.html",
    },
    { kind: "structural_capture", date: "2026-09-25", reference: "2-picker-open.html" },
  ],
};

export type ModelCatalogIssue =
  | ScanReason
  | "no_verified_candidate"
  | "picker_not_expanded"
  | "label_unreadable"
  | "label_invalid"
  | "checked_unknown"
  | "enabled_unknown"
  | "provider_id_unknown"
  | "duplicate_label"
  | "duplicate_id"
  | "duplicate_legacy_model"
  | "checked_count_invalid"
  | "row_changed"
  | "no_options";

/** Visible rows only; collection must retain unknown states rather than defaulting them. */
export interface ModelRowObservation {
  label: string | null;
  checked: boolean | null;
  enabled: boolean | null;
  providerModelId: string | null;
}

export interface VisibleModelOption extends ProviderCatalogOption {
  legacyModel: ObservedModel | null;
  issues: ModelCatalogIssue[];
}

export interface VisibleModelCatalog extends ProviderCatalogSnapshot {
  version: typeof MODEL_CATALOG_VERSION;
  provider: "chatgpt";
  route: "ordinary_chat_browser";
  selectorProfileVersion: string;
  selectorProfileEvidence: ModelSelectorProfile["evidence"];
  catalogFingerprint: string;
  issues: ModelCatalogIssue[];
  options: VisibleModelOption[];
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function labelIdentity(label: string): string {
  return (label.split(/\r?\n/)[0] ?? "").trim().toLowerCase();
}

/** Pure projection. A catalog never grants model, capability, quota or execution permission. */
export function buildModelCatalog(
  rows: readonly ModelRowObservation[],
  opts: {
    contextId: string;
    observedAt: string;
    profile?: ModelSelectorProfile;
    complete?: boolean;
    issues?: readonly ModelCatalogIssue[];
  },
): VisibleModelCatalog {
  const profile = opts.profile ?? MODEL_SELECTOR_PROFILE;
  const issues: ModelCatalogIssue[] = [...(opts.issues ?? [])];
  let complete = opts.complete ?? true;
  if (rows.length > MAX_DOM_CANDIDATES) {
    complete = false;
    issues.push("candidate_limit");
  }
  const options: VisibleModelOption[] = rows.slice(0, MAX_DOM_CANDIDATES).map((row) => {
    const rowIssues: ModelCatalogIssue[] = [];
    const validLabel =
      row.label !== null &&
      row.label.trim().length > 0 &&
      row.label.length <= MAX_MODEL_LABEL_LENGTH;
    // Keep exact bounded text; never interpret a truncated label as a known alias.
    const label = (row.label ?? "").slice(0, MAX_MODEL_LABEL_LENGTH);
    if (!validLabel) rowIssues.push(row.label === null ? "label_unreadable" : "label_invalid");
    if (row.checked === null) rowIssues.push("checked_unknown");
    if (row.enabled === null) rowIssues.push("enabled_unknown");
    let providerModelId: string | null = null;
    if (profile.providerModelIdAttribute !== null) {
      if (
        row.providerModelId !== null &&
        row.providerModelId.trim().length > 0 &&
        row.providerModelId.length <= MAX_PROVIDER_MODEL_ID_LENGTH
      ) {
        providerModelId = row.providerModelId;
      } else rowIssues.push("provider_id_unknown");
    }
    if (rowIssues.length > 0) complete = false;
    const alias = validLabel ? reverseLookupModel(label, "en") : { error: "unmapped" as const };
    return {
      observationKey: "",
      label,
      providerModelId,
      identitySource: providerModelId === null ? "unverified_label" : "provider_reported",
      legacyModel: "model" in alias ? alias.model : null,
      checked: row.checked,
      enabled: row.enabled,
      ambiguity: rowIssues.length > 0 ? "unknown" : "none",
      issues: rowIssues,
      effort: { scope: "unknown", values: [], source: null },
    };
  });
  for (const option of options) {
    if (
      options.filter((other) => labelIdentity(other.label) === labelIdentity(option.label)).length >
      1
    ) {
      option.issues.push("duplicate_label");
      option.ambiguity = "duplicate_label";
    }
    if (
      option.providerModelId !== null &&
      options.filter((other) => other.providerModelId === option.providerModelId).length > 1
    ) {
      option.issues.push("duplicate_id");
      option.ambiguity = "duplicate_id";
    }
    if (
      option.legacyModel !== null &&
      options.filter((other) => other.legacyModel === option.legacyModel).length > 1
    ) {
      option.issues.push("duplicate_legacy_model");
      if (option.ambiguity === "none") option.ambiguity = "unknown";
    }
  }
  if (options.length === 0) issues.push("no_options");
  if (options.length > 0 && options.filter((option) => option.checked === true).length !== 1)
    issues.push("checked_count_invalid");
  const allIssues = [...new Set([...issues, ...options.flatMap((option) => option.issues)])].sort();
  const reason = !complete ? "incomplete" : allIssues.length > 0 ? "ambiguous" : "none";
  const scope = {
    providerId: "chatgpt",
    routeId: "ordinary_chat_browser",
    contextId: opts.contextId,
    revision: { kind: "dom_profile" as const, id: "chatgpt-picker", version: profile.version },
  };
  // Sort canonical row material, retaining duplicates. Display order/time are not model identity.
  const material = options.map(({ observationKey: _key, ...option }) => option);
  const catalogFingerprint = hash({
    version: MODEL_CATALOG_VERSION,
    scope,
    profile,
    complete,
    reason,
    issues: allIssues,
    rows: material.map((row) => JSON.stringify(row)).sort(),
  });
  const occurrences = new Map<string, number>();
  options.forEach((option, index) => {
    const rowHash = hash(material[index]);
    const ordinal = occurrences.get(rowHash) ?? 0;
    occurrences.set(rowHash, ordinal + 1);
    option.observationKey = `ui-option:${catalogFingerprint}:${rowHash}:${ordinal}`;
  });
  return {
    schema: "bridge-provider-catalog-1",
    version: MODEL_CATALOG_VERSION,
    provider: "chatgpt",
    route: "ordinary_chat_browser",
    scope,
    observedAt: opts.observedAt,
    selectorProfileVersion: profile.version,
    selectorProfileEvidence: profile.evidence,
    catalogFingerprint,
    source: {
      kind: "browser_dom",
      operation: "inspect_scoped_model_picker",
      formatId: MODEL_CATALOG_VERSION,
      contentSha256: catalogFingerprint,
    },
    complete,
    reason,
    issues: allIssues,
    options,
    effortSyntax: { scope: "unknown", values: [], source: null },
    accountAvailability: "unknown",
    cost: "unknown",
    executionAuthorized: false,
  };
}

/** Legacy execution is deliberately closed even when discovery sees a new label/provider ID. */
export function legacyCatalogSelection(
  catalog: VisibleModelCatalog,
  target: ObservedModel | "current",
): { ok: true; option: VisibleModelOption } | { ok: false; cause: string; available: boolean } {
  if (!catalog.complete || catalog.reason !== "none")
    return { ok: false, cause: `model catalog ${catalog.reason}`, available: true };
  const hits = catalog.options.filter((option) =>
    target === "current" ? option.checked === true : option.legacyModel === target,
  );
  if (hits.length === 0) return { ok: false, cause: "model not in picker", available: false };
  if (hits.length !== 1) return { ok: false, cause: "model catalog ambiguous", available: true };
  const option = hits[0] as VisibleModelOption;
  if (option.legacyModel === null)
    return { ok: false, cause: "unmapped model label", available: true };
  if (option.enabled !== true)
    return { ok: false, cause: "model option disabled or unknown", available: true };
  return { ok: true, option };
}
