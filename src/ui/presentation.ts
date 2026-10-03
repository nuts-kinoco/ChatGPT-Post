/** Host-managed cosmetic preferences. This store contains no jobs, destinations or authority. */
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ajv2020 } from "ajv/dist/2020.js";
import { REPO_ROOT } from "../contracts/schema.js";
import { parseStrictJsonBytes } from "../contracts/task.js";
import { UiError } from "../contracts/ui.js";

export interface PresentationValues {
  theme: "light" | "dark";
  alwaysOnTop: boolean;
  hideWhenInactive: boolean;
  minimizeToTray: boolean;
  completionNotifications: boolean;
}
export interface PresentationSnapshot {
  version: "bridge-presentation-1";
  revision: number;
  values: PresentationValues;
}
export interface PresentationUpdate {
  expectedRevision: number;
  patch: Partial<PresentationValues>;
}
export const PRESENTATION_DEFAULTS: Readonly<PresentationValues> = Object.freeze({
  theme: "light",
  alwaysOnTop: false,
  hideWhenInactive: false,
  minimizeToTray: false,
  completionNotifications: true,
});
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(
  JSON.parse(
    readFileSync(join(REPO_ROOT, "schemas/ui-presentation.schema.json"), "utf8"),
  ) as object,
);
const validateValues = ajv.compile({
  $ref: "https://example.invalid/bridge-v2/ui-presentation.schema.json#/$defs/values",
});
const validateUpdate = ajv.compile({
  $ref: "https://example.invalid/bridge-v2/ui-presentation.schema.json#/$defs/update",
});

export class PresentationStore {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(snapshot: PresentationSnapshot) => void>();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS presentation_preferences (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, body TEXT NOT NULL)",
    );
    this.db
      .prepare("INSERT OR IGNORE INTO presentation_preferences VALUES (1,1,?)")
      .run(JSON.stringify(PRESENTATION_DEFAULTS));
    try {
      this.snapshot();
    } catch (error) {
      this.db.close();
      throw error;
    } // Never silently reset corrupt preferences.
  }
  snapshot(): PresentationSnapshot {
    const row = this.db
      .prepare("SELECT revision,body FROM presentation_preferences WHERE singleton=1")
      .get() as { revision: number; body: string } | undefined;
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1)
      throw new UiError(
        "presentation_corrupt",
        "Stored display preferences could not be verified",
        409,
      );
    let values: unknown;
    try {
      if (Buffer.byteLength(row.body) > 4096) throw new Error("oversized");
      values = parseStrictJsonBytes(Buffer.from(row.body));
    } catch {
      throw new UiError(
        "presentation_corrupt",
        "Stored display preferences could not be parsed safely",
        409,
      );
    }
    if (!validateValues(values))
      throw new UiError(
        "presentation_corrupt",
        "Stored display preferences failed validation",
        409,
      );
    return {
      version: "bridge-presentation-1",
      revision: row.revision,
      values: structuredClone(values as PresentationValues),
    };
  }
  update(input: unknown, nativeAvailable: boolean): PresentationSnapshot {
    if (!validateUpdate(input))
      throw new UiError(
        "invalid_presentation",
        "Display settings do not match the presentation contract",
      );
    const update = input as PresentationUpdate;
    if (
      !nativeAvailable &&
      ["alwaysOnTop", "hideWhenInactive", "minimizeToTray"].some((key) =>
        Object.hasOwn(update.patch, key),
      )
    )
      throw new UiError(
        "native_controls_unavailable",
        "These window controls require the desktop Bridge app",
        409,
      );
    this.db.exec("BEGIN IMMEDIATE");
    let snapshot: PresentationSnapshot;
    try {
      const prior = this.snapshot();
      if (prior.revision !== update.expectedRevision)
        throw new UiError(
          "stale_presentation",
          "Display settings changed; refresh before saving",
          409,
        );
      const values = { ...prior.values, ...update.patch };
      if (!validateValues(values))
        throw new UiError("invalid_presentation", "Display settings failed validation");
      this.db
        .prepare("UPDATE presentation_preferences SET revision=?,body=? WHERE singleton=1")
        .run(prior.revision + 1, JSON.stringify(values));
      snapshot = { version: "bridge-presentation-1", revision: prior.revision + 1, values };
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(snapshot));
      } catch {
        /* Saved preferences remain authoritative; listeners are observers only. */
      }
    }
    return structuredClone(snapshot);
  }
  subscribe(listener: (snapshot: PresentationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.listeners.clear();
    this.db.close();
  }
}
export async function openPresentationStore(stateDir: string): Promise<PresentationStore> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  return new PresentationStore(join(stateDir, "presentation.db"));
}
