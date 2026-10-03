/** Prospective settings on the canonical revisioned registry; never an execution grant. */
import { parseProjectRegistry } from "../contracts/project-registry.js";
import { UiError } from "../contracts/ui.js";
import type { UiOperationsSources } from "./operations.js";
export class UiProjectSettings {
  constructor(private readonly registry: UiOperationsSources["registry"]) {}
  view() {
    if (!this.registry)
      return {
        version: "bridge-project-settings-1",
        state: "unavailable",
        reason: "project_registry_unconfigured",
        configurable: false,
      };
    try {
      const revision = this.registry.currentRevision();
      return {
        version: "bridge-project-settings-1",
        state: "available",
        revision,
        snapshot: revision === 0 ? null : this.registry.snapshot(revision),
        snapshotSha256: revision === 0 ? null : this.registry.snapshotHash(revision),
        configurable: typeof this.registry.configure === "function",
        pathVerification: "not_probed",
        executionAuthority: false,
      };
    } catch {
      throw new UiError("registry_read_failed", "Project registry could not be read safely", 409);
    }
  }
  update(input: unknown) {
    if (!this.registry?.configure)
      throw new UiError(
        "registry_settings_unavailable",
        "Canonical registry settings are not configured",
        409,
      );
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join() !== "expectedRevision,snapshot"
    )
      throw new UiError(
        "invalid_registry_settings",
        "Only expectedRevision and a complete registry snapshot are accepted",
      );
    const value = input as { expectedRevision: unknown; snapshot: unknown };
    if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0)
      throw new UiError(
        "invalid_registry_revision",
        "Expected revision must be a nonnegative integer",
      );
    try {
      const snapshot = parseProjectRegistry(Buffer.from(JSON.stringify(value.snapshot)));
      this.registry.configure(snapshot, Number(value.expectedRevision));
      return this.view();
    } catch (error) {
      if (error instanceof UiError) throw error;
      throw new UiError(
        "registry_update_rejected",
        "Registry validation, immutable identity, or revision check failed; refresh before editing",
        409,
      );
    }
  }
}
