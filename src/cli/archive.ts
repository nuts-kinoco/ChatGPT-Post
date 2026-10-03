/** Explicit archive operations. Shared registry configuration is prospective; reads never migrate. */
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { openTrustedDeployment } from "../adapters/deployment-loader.js";
import type { ArchiveOperations } from "../archive/operations.js";
import {
  checkedDirectory,
  portableFilename,
  probeOutputRoot,
  readOwnedFile,
  writeNewFile,
} from "../archive/paths.js";
import { publicArchiveErrorCode } from "../archive/public-errors.js";
import { RouteArtifactArchive } from "../archive/route-store.js";
import { ArtifactArchive } from "../archive/store.js";
import { ArchiveError } from "../archive/types.js";
import {
  type ProjectRegistrySnapshot,
  parseProjectRegistry,
  projectRegistryHash,
} from "../contracts/project-registry.js";
import { ProjectRegistry } from "../state/project-registry.js";
export const ARCHIVE_HELP = `chatgpt-bridge archive <command> [options]
  settings --state-dir <private existing dir>
  configure --state-dir <dir> --revision <n> [--default-root <owned existing root>]
            [--repo <repo ID> --name <display name> --storage-slug <immutable slug>]
            [--project-root <owned root> | --use-default]
  probe --root <owned existing root>
  inspect <request UUID> --state-dir <dir> [--manifest <SHA256>]
  legacy-inspect <request UUID> --state-dir <dir>
  save <request UUID> --deployment <trusted module>
  export <request UUID> --deployment <trusted module> --out <new JSON file>

The trusted deployment exports archiveOperations from createArchiveOperations. Save never runs a
model; export writes one sanitized JSON+README file and never uploads. Inspection is read-only.
Shared project-registry.db settings apply only to newly accepted admissions. No move/delete/migration.
Explicit probe alone writes a temporary output-root file. Windows storage remains unavailable until
native ownership/reparse and durability enforcement is implemented; no user drive is auto-created.
`;
function readSettings(state: string): ProjectRegistrySnapshot {
  const path = join(state, "project-registry.db");
  readOwnedFile(path, 512 * 1024 * 1024);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT body,snapshot_hash FROM project_registry_history ORDER BY revision DESC LIMIT 1",
      )
      .get();
    if (!row) throw new ArchiveError("archive_registry_unconfigured");
    const value = parseProjectRegistry(Buffer.from(String(row.body)));
    if (projectRegistryHash(value) !== row.snapshot_hash)
      throw new ArchiveError("archive_registry_corrupt");
    return value;
  } finally {
    db.close();
  }
}
export async function runArchiveCli(
  argv: string[],
  stdout: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): Promise<number> {
  const print = (value: unknown) => stdout(`${JSON.stringify(value)}\n`);
  let deployment:
    | { archiveOperations?: ArchiveOperations; close?(): void | Promise<void> }
    | undefined;
  const run = async (): Promise<number> => {
    try {
      const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          "state-dir": { type: "string" },
          revision: { type: "string" },
          "default-root": { type: "string" },
          repo: { type: "string" },
          name: { type: "string" },
          "storage-slug": { type: "string" },
          "project-root": { type: "string" },
          "use-default": { type: "boolean" },
          root: { type: "string" },
          deployment: { type: "string" },
          out: { type: "string" },
          manifest: { type: "string" },
          help: { type: "boolean" },
        },
      });
      const command = positionals[0],
        id = positionals[1];
      if (!command || command === "help" || values.help) {
        stdout(ARCHIVE_HELP);
        return 0;
      }
      const perId = ["inspect", "legacy-inspect", "save", "export"].includes(command);
      if (
        positionals.length !== (perId ? 2 : 1) ||
        (!perId && !["settings", "configure", "probe"].includes(command))
      )
        throw new ArchiveError("archive_arguments_invalid");
      if (
        perId &&
        (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
      )
        throw new ArchiveError("archive_identity_invalid");
      const allowed: Record<string, string[]> = {
        settings: ["state-dir"],
        configure: [
          "state-dir",
          "revision",
          "default-root",
          "repo",
          "name",
          "storage-slug",
          "project-root",
          "use-default",
        ],
        probe: ["root", "state-dir"],
        inspect: ["state-dir", "manifest"],
        "legacy-inspect": ["state-dir"],
        save: ["deployment"],
        export: ["deployment", "out"],
      };
      if (Object.keys(values).some((k) => !allowed[command]?.includes(k)))
        throw new ArchiveError("archive_arguments_invalid");
      if (command === "save" || command === "export") {
        if (!values.deployment) throw new ArchiveError("archive_deployment_required");
        deployment = await openTrustedDeployment(values.deployment);
        if (!deployment?.archiveOperations)
          throw new ArchiveError("archive_operations_unconfigured");
        if (command === "save") print(await deployment.archiveOperations.collect(id ?? ""));
        else {
          if (!values.out) throw new ArchiveError("archive_export_output_required");
          const result = deployment.archiveOperations.exportDiagnostics(id ?? "");
          const path = resolve(values.out);
          portableFilename(path.slice(dirname(path).length + 1));
          writeNewFile(path, result.bytes);
          print({
            ok: true,
            file: path,
            contentSha256: result.contentSha256,
            fileSha256: result.sha256,
            rawPromptsIncluded: false,
            uploaded: false,
            reexecute: false,
          });
        }
        return 0;
      }
      if (command === "probe") {
        if (!values.root) throw new ArchiveError("archive_root_required");
        print(probeOutputRoot(resolve(values.root)));
        return 0;
      }
      if (!values["state-dir"]) throw new ArchiveError("archive_state_directory_required");
      const state = resolve(values["state-dir"]);
      checkedDirectory(state, {}, true);
      if (command === "settings") {
        print(readSettings(state));
        return 0;
      }
      if (command === "inspect" || command === "legacy-inspect") {
        const archive =
          command === "inspect"
            ? new RouteArtifactArchive({ stateDirectory: state, readOnly: true })
            : new ArtifactArchive({ stateDirectory: state, readOnly: true });
        try {
          const result =
            command === "inspect"
              ? (archive as RouteArtifactArchive).inspect(id ?? "", values.manifest)
              : archive.inspect(id ?? "");
          print(result);
          return result.state === "complete" ? 0 : 4;
        } finally {
          archive.close();
        }
      }
      if (
        !values.revision ||
        !/^\d+$/.test(values.revision) ||
        (!values["default-root"] && !values.repo) ||
        (values["project-root"] && values["use-default"]) ||
        (!values.repo &&
          (values.name ||
            values["storage-slug"] ||
            values["project-root"] ||
            values["use-default"]))
      )
        throw new ArchiveError("archive_arguments_invalid");
      if (values["default-root"]) checkedDirectory(resolve(values["default-root"]));
      if (values["project-root"]) checkedDirectory(resolve(values["project-root"]));
      const registry = new ProjectRegistry(join(state, "project-registry.db"));
      try {
        const revision = registry.currentRevision();
        if (revision !== Number(values.revision)) throw new ArchiveError("archive_settings_stale");
        const snapshot: ProjectRegistrySnapshot = revision
          ? registry.snapshot()
          : {
              schema: "bridge-project-registry-1",
              revision: 0,
              defaultOutputRoot: null,
              projects: [],
            };
        snapshot.revision = revision + 1;
        if (values["default-root"]) snapshot.defaultOutputRoot = resolve(values["default-root"]);
        if (values.repo) {
          const prior = snapshot.projects.find((p) => p.repoId === values.repo);
          if (!prior && (!values.name || !values["storage-slug"]))
            throw new ArchiveError("archive_new_project_name_slug_required");
          if (prior && values["storage-slug"] && prior.storageSlug !== values["storage-slug"])
            throw new ArchiveError("archive_project_identity_immutable");
          if (prior) {
            if (values.name) prior.displayName = values.name;
            if (values["project-root"]) prior.outputRootOverride = resolve(values["project-root"]);
            else if (values["use-default"]) prior.outputRootOverride = null;
          } else
            snapshot.projects.push({
              projectId: randomUUID(),
              repoId: values.repo,
              displayName: values.name ?? "",
              storageSlug: values["storage-slug"] ?? "",
              githubDestination: null,
              outputRootOverride: values["project-root"] ? resolve(values["project-root"]) : null,
            });
        }
        registry.configure(snapshot, revision);
        print(registry.snapshot());
        return 0;
      } finally {
        registry.close();
      }
    } catch (error) {
      print({
        ok: false,
        code: publicArchiveErrorCode(error),
        retryable: error instanceof ArchiveError && error.retryable,
        reexecute: false,
        nextAction: "Inspect the same request and pinned storage; never retry execution",
      });
      return 4;
    }
  };
  const result = await run();
  try {
    await deployment?.close?.();
  } catch {
    print({ ok: false, code: "archive_cleanup_failed", retryable: false, reexecute: false });
    return 4;
  }
  return result;
}
