/** Versioned route-neutral archive. Admission precedes acceptance; stored output never authorizes a run. */
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ProjectRegistration,
  parseProjectRegistry,
  projectRegistryHash,
  serializeProjectRegistry,
} from "../contracts/project-registry.js";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
import {
  assertRootIdentity,
  type DurableFile,
  publishImmutableFiles,
  rootIdentity,
} from "./durable.js";
import {
  archivePath,
  checkedDirectory,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_FILE_BYTES,
  MAX_ARCHIVE_TOTAL_BYTES,
  type PathPolicy,
  portableFilename,
  readOwnedFile,
} from "./paths.js";
import type {
  ArchiveInspectionV2,
  ArchiveItemV2,
  ArchivePinV2,
  ArchiveRegistryPort,
  ArchiveSnapshotV2,
  ArchiveSourceReaderV1,
  ArtifactArchiveManifestV2,
  JobAdmissionV1,
  JobProvenanceEventV1,
} from "./route-types.js";
import {
  admissionDigest,
  exact,
  HASH,
  ID,
  validateAdmission,
  validateProvenance,
  validateSource,
} from "./route-validation.js";
import { ArchiveError } from "./types.js";
export interface RouteArchiveOptions {
  stateDirectory: string;
  registry?: ArchiveRegistryPort;
  pathPolicy?: PathPolicy;
  readOnly?: boolean;
}
function code(error: unknown): string {
  if (error instanceof ArchiveError) return error.code;
  const value = (error as NodeJS.ErrnoException).code;
  return value === "ENOENT"
    ? "archive_path_missing"
    : value === "ENOSPC"
      ? "archive_disk_full"
      : ["EACCES", "EPERM", "EROFS"].includes(value ?? "")
        ? "archive_permission_denied"
        : "archive_io_failed";
}
export class RouteArtifactArchive {
  private readonly db: DatabaseSync;
  private readonly sealedPins: boolean;
  readonly registry: ArchiveRegistryPort;
  readonly pathPolicy: PathPolicy;
  constructor(options: RouteArchiveOptions) {
    if (!options.registry && !options.readOnly) throw new ArchiveError("archive_registry_required");
    const unavailable = (): never => {
      throw new ArchiveError("archive_registry_unavailable_readonly");
    };
    this.registry = options.registry ?? {
      currentRevision: unavailable,
      snapshot: unavailable,
      snapshotHash: unavailable,
      resolve: unavailable,
      defaultOutputRoot: unavailable,
    };
    this.pathPolicy = options.pathPolicy ?? {};
    checkedDirectory(options.stateDirectory, this.pathPolicy, true);
    const path = join(options.stateDirectory, "route-archive.db");
    if (!options.readOnly)
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    readOwnedFile(path, 512 * 1024 * 1024, this.pathPolicy);
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    if (!options.readOnly)
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS archive2_admissions (request_id TEXT PRIMARY KEY, admission TEXT NOT NULL, hash TEXT NOT NULL, pin TEXT NOT NULL, pin_hash TEXT, registry_snapshot TEXT);
      CREATE TABLE IF NOT EXISTS archive2_provenance (request_id TEXT NOT NULL, sequence INTEGER NOT NULL, source TEXT NOT NULL, source_revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(request_id,sequence), UNIQUE(request_id,source,source_revision));
      CREATE TABLE IF NOT EXISTS archive2_manifests (request_id TEXT NOT NULL, sequence INTEGER NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(request_id,sequence), UNIQUE(request_id,digest));
      CREATE TABLE IF NOT EXISTS archive2_materializations (request_id TEXT NOT NULL, event_id TEXT NOT NULL, receipt_hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(request_id,event_id));`);
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(archive2_admissions)")
        .all()
        .map((row) => String(row.name)),
    );
    if (!options.readOnly) {
      for (const column of ["pin_hash", "registry_snapshot"])
        if (!columns.has(column)) {
          this.db.exec(`ALTER TABLE archive2_admissions ADD COLUMN ${column} TEXT`);
          columns.add(column);
        }
    }
    this.sealedPins = columns.has("pin_hash") && columns.has("registry_snapshot");
  }
  close(): void {
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  hasPin(requestId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM archive2_admissions WHERE request_id=?").get(requestId);
  }
  reserve(input: JobAdmissionV1, acceptedPreviously = false): ArchivePinV2 {
    const admission = structuredClone(input);
    validateAdmission(admission);
    const hash = admissionDigest(admission);
    return this.transaction(() => {
      const old = this.db
        .prepare("SELECT hash,pin FROM archive2_admissions WHERE request_id=?")
        .get(admission.requestId);
      if (old) {
        if (old.hash !== hash) throw new ArchiveError("archive_admission_conflict");
        return this.pin(admission.requestId);
      }
      if (acceptedPreviously) throw new ArchiveError("archive_legacy_admission_unpinned");
      const registrySnapshot = parseProjectRegistry(
        Buffer.from(serializeProjectRegistry(this.registry.snapshot(admission.registryRevision))),
      );
      const project = registrySnapshot.projects.find((p) => p.repoId === admission.repoId);
      if (
        registrySnapshot.revision !== admission.registryRevision ||
        projectRegistryHash(registrySnapshot) !== admission.registrySnapshotHash ||
        !project ||
        project.projectId !== admission.projectId ||
        project.repoId !== admission.repoId ||
        project.storageSlug !== admission.storageSlug
      )
        throw new ArchiveError("archive_registry_binding_mismatch");
      const root = project.outputRootOverride ?? registrySnapshot.defaultOutputRoot;
      if (!root) throw new ArchiveError("archive_root_unconfigured");
      const pin: ArchivePinV2 = {
        schema: "archive-pin-2",
        admissionHash: hash,
        requestId: admission.requestId,
        registryRevision: admission.registryRevision,
        registrySnapshotHash: admission.registrySnapshotHash,
        projectId: project.projectId,
        repoId: project.repoId,
        storageSlug: project.storageSlug,
        localPinnedRoot: root,
        rootIdentity: rootIdentity(root, this.pathPolicy),
        relativeDirectory: `ChatGPT-Bridge/projects/${project.storageSlug}/requests/${admission.requestId}`,
      };
      this.db
        .prepare(
          "INSERT INTO archive2_admissions (request_id,admission,hash,pin,pin_hash,registry_snapshot) VALUES (?,?,?,?,?,?)",
        )
        .run(
          admission.requestId,
          JSON.stringify(admission),
          hash,
          JSON.stringify(pin),
          sha256Bytes(Buffer.from(JSON.stringify(pin))),
          serializeProjectRegistry(registrySnapshot),
        );
      return pin;
    });
  }
  admission(requestId: string): JobAdmissionV1 {
    const row = this.db
      .prepare("SELECT admission,hash FROM archive2_admissions WHERE request_id=?")
      .get(requestId);
    if (!row) throw new ArchiveError("archive_pin_missing");
    const admission = parseStrictJsonBytes(Buffer.from(String(row.admission))) as JobAdmissionV1;
    if (admissionDigest(admission) !== row.hash)
      throw new ArchiveError("archive_admission_corrupt");
    return admission;
  }
  pin(requestId: string): ArchivePinV2 {
    const admission = this.admission(requestId);
    if (!this.sealedPins) throw new ArchiveError("archive_legacy_pin_unsealed");
    const row = this.db
      .prepare("SELECT pin,pin_hash,registry_snapshot FROM archive2_admissions WHERE request_id=?")
      .get(requestId);
    if (!row?.pin_hash || !row.registry_snapshot)
      throw new ArchiveError("archive_legacy_pin_unsealed");
    if (sha256Bytes(Buffer.from(String(row.pin))) !== row.pin_hash)
      throw new ArchiveError("archive_pin_hash_mismatch");
    const registrySnapshot = parseProjectRegistry(Buffer.from(String(row.registry_snapshot)));
    if (
      registrySnapshot.revision !== admission.registryRevision ||
      projectRegistryHash(registrySnapshot) !== admission.registrySnapshotHash
    )
      throw new ArchiveError("archive_registry_binding_mismatch");
    const registered = registrySnapshot.projects.find((p) => p.repoId === admission.repoId);
    if (
      !registered ||
      registered.projectId !== admission.projectId ||
      registered.storageSlug !== admission.storageSlug
    )
      throw new ArchiveError("archive_registry_binding_mismatch");
    const pin = parseStrictJsonBytes(Buffer.from(String(row.pin))) as ArchivePinV2;
    if (
      pin.localPinnedRoot !== (registered.outputRootOverride ?? registrySnapshot.defaultOutputRoot)
    )
      throw new ArchiveError("archive_pin_root_mismatch");
    exact(pin, [
      "schema",
      "admissionHash",
      "requestId",
      "registryRevision",
      "registrySnapshotHash",
      "projectId",
      "repoId",
      "storageSlug",
      "localPinnedRoot",
      "rootIdentity",
      "relativeDirectory",
    ]);
    if (
      pin.schema !== "archive-pin-2" ||
      pin.admissionHash !== admissionDigest(admission) ||
      pin.requestId !== requestId ||
      pin.registryRevision !== admission.registryRevision ||
      pin.registrySnapshotHash !== admission.registrySnapshotHash ||
      pin.projectId !== admission.projectId ||
      pin.repoId !== admission.repoId ||
      pin.storageSlug !== admission.storageSlug ||
      pin.relativeDirectory !==
        `ChatGPT-Bridge/projects/${admission.storageSlug}/requests/${requestId}`
    )
      throw new ArchiveError("archive_pin_corrupt");
    exact(pin.rootIdentity, ["device", "inode"]);
    if (!/^\d+$/.test(pin.rootIdentity.device) || !/^\d+$/.test(pin.rootIdentity.inode))
      throw new ArchiveError("archive_pin_corrupt");
    return pin;
  }
  projectRegistration(requestId: string): ProjectRegistration {
    this.pin(requestId);
    const admission = this.admission(requestId);
    const row = this.db
      .prepare("SELECT registry_snapshot FROM archive2_admissions WHERE request_id=?")
      .get(requestId);
    const project = parseProjectRegistry(Buffer.from(String(row?.registry_snapshot))).projects.find(
      (p) => p.repoId === admission.repoId,
    );
    if (!project) throw new ArchiveError("archive_registry_binding_mismatch");
    return structuredClone(project);
  }
  provenance(requestId: string): JobProvenanceEventV1[] {
    const admission = this.admission(requestId);
    return this.db
      .prepare("SELECT body FROM archive2_provenance WHERE request_id=? ORDER BY sequence")
      .all(requestId)
      .map((row) => {
        const value = parseStrictJsonBytes(Buffer.from(String(row.body))) as JobProvenanceEventV1;
        validateProvenance(value, admission);
        return value;
      });
  }
  appendProvenance(requestId: string, input: JobProvenanceEventV1): void {
    const value = structuredClone(input);
    validateProvenance(value, this.admission(requestId));
    const body = JSON.stringify(value);
    this.transaction(() => {
      const prior = this.db
        .prepare(
          "SELECT source_revision,body FROM archive2_provenance WHERE request_id=? AND source=? ORDER BY source_revision DESC LIMIT 1",
        )
        .get(requestId, value.source);
      if (prior && Number(prior.source_revision) >= value.sourceRevision) {
        const exact = this.db
          .prepare(
            "SELECT body FROM archive2_provenance WHERE request_id=? AND source=? AND source_revision=?",
          )
          .get(requestId, value.source, value.sourceRevision);
        if (exact?.body === body) return;
        throw new ArchiveError("archive_provenance_stale_or_conflicting");
      }
      const seq = Number(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence),0)+1 AS seq FROM archive2_provenance WHERE request_id=?",
          )
          .get(requestId)?.seq,
      );
      if (seq > 4096) throw new ArchiveError("archive_provenance_limit");
      this.db
        .prepare("INSERT INTO archive2_provenance VALUES (?,?,?,?,?)")
        .run(requestId, seq, value.source, value.sourceRevision, body);
    });
  }
  private manifestDirectory(pin: ArchivePinV2, digest: string): string {
    if (!HASH.test(digest)) throw new ArchiveError("archive_manifest_hash_invalid");
    return `${pin.relativeDirectory}/archives/${digest}`;
  }
  inspect(requestId: string, digest?: string): ArchiveInspectionV2 {
    const pin = this.pin(requestId);
    const base = {
      schema: "archive-inspection-2" as const,
      pin,
      manifest: null,
      manifestSha256: null,
      issue: null,
      reexecute: false as const,
    };
    const row = digest
      ? this.db
          .prepare("SELECT digest,body FROM archive2_manifests WHERE request_id=? AND digest=?")
          .get(requestId, digest)
      : this.db
          .prepare(
            "SELECT digest,body FROM archive2_manifests WHERE request_id=? ORDER BY sequence DESC LIMIT 1",
          )
          .get(requestId);
    if (!row) return { ...base, state: "not_archived" };
    try {
      const text = String(row.body),
        hash = String(row.digest);
      if (sha256Bytes(Buffer.from(text)) !== hash)
        throw new ArchiveError("archive_manifest_hash_mismatch");
      const manifest = parseStrictJsonBytes(Buffer.from(text)) as ArtifactArchiveManifestV2;
      this.validateManifest(manifest, pin);
      assertRootIdentity(pin.localPinnedRoot, pin.rootIdentity, this.pathPolicy);
      const root = archivePath(pin.localPinnedRoot, this.manifestDirectory(pin, hash));
      if (
        !readOwnedFile(join(root, "manifest.json"), MAX_ARCHIVE_FILE_BYTES, this.pathPolicy).equals(
          Buffer.from(text),
        )
      )
        throw new ArchiveError("archive_manifest_hash_mismatch");
      for (const [path, expected] of [
        [manifest.instructions.taskSpecPath, manifest.admission.taskSpecHash],
        [manifest.instructions.taskFilePath, manifest.admission.taskFileHash],
      ])
        if (
          sha256Bytes(
            readOwnedFile(join(root, path as string), MAX_ARCHIVE_FILE_BYTES, this.pathPolicy),
          ) !== expected
        )
          throw new ArchiveError("archive_content_hash_mismatch");
      const payload = readOwnedFile(
        join(root, "results/result.json"),
        MAX_ARCHIVE_FILE_BYTES,
        this.pathPolicy,
      );
      if (
        payload.length !== manifest.payload.sizeBytes ||
        sha256Bytes(payload) !== manifest.payload.contentSha256
      )
        throw new ArchiveError("archive_content_hash_mismatch");
      for (const item of manifest.items)
        if (item.state === "complete") {
          const bytes = readOwnedFile(
            archivePath(root, item.relativePath ?? ""),
            MAX_ARCHIVE_FILE_BYTES,
            this.pathPolicy,
          );
          if (bytes.length !== item.sizeBytes || sha256Bytes(bytes) !== item.contentSha256)
            throw new ArchiveError("archive_content_hash_mismatch");
        }
      return {
        ...base,
        state: manifest.complete ? "complete" : "incomplete",
        manifest,
        manifestSha256: hash,
      };
    } catch (error) {
      const issue = code(error);
      return {
        ...base,
        state: ["archive_path_missing", "archive_permission_denied", "archive_io_failed"].includes(
          issue,
        )
          ? "unavailable"
          : "corrupt",
        issue,
      };
    }
  }
  readItem(requestId: string, manifestSha256: string, artifactId: string | null): Uint8Array {
    const checked = this.inspect(requestId, manifestSha256);
    if (checked.state !== "complete" || !checked.manifest)
      throw new ArchiveError("archive_read_requires_complete_manifest");
    const item =
      artifactId === null
        ? checked.manifest.payload
        : checked.manifest.items.find(
            (item) => item.artifactId === artifactId && item.state === "complete",
          );
    if (!item?.relativePath) throw new ArchiveError("archive_item_unavailable");
    const root = archivePath(
      checked.pin.localPinnedRoot,
      this.manifestDirectory(checked.pin, manifestSha256),
    );
    const bytes = readOwnedFile(
      archivePath(root, item.relativePath),
      MAX_ARCHIVE_FILE_BYTES,
      this.pathPolicy,
    );
    if (bytes.length !== item.sizeBytes || sha256Bytes(bytes) !== item.contentSha256)
      throw new ArchiveError("archive_content_hash_mismatch");
    return bytes;
  }
  private validateManifest(m: ArtifactArchiveManifestV2, pin: ArchivePinV2): void {
    exact(m, [
      "schema",
      "admission",
      "admissionHash",
      "pin",
      "provenance",
      "instructions",
      "payload",
      "items",
      "requiredSetKnown",
      "complete",
      "synthetic",
    ]);
    if (
      m.schema !== "artifact-archive-2" ||
      admissionDigest(m.admission) !== pin.admissionHash ||
      m.admissionHash !== pin.admissionHash ||
      JSON.stringify(m.pin) !== JSON.stringify(pin) ||
      !Array.isArray(m.provenance) ||
      m.provenance.length > 4096 ||
      !Array.isArray(m.items) ||
      m.items.length > MAX_ARCHIVE_ENTRIES - 4 ||
      typeof m.complete !== "boolean" ||
      typeof m.requiredSetKnown !== "boolean" ||
      typeof m.synthetic !== "boolean"
    )
      throw new ArchiveError("archive_manifest_invalid");
    exact(m.instructions, ["taskSpecPath", "taskFilePath"]);
    if (
      m.instructions.taskSpecPath !== "instructions/TaskSpec.json" ||
      m.instructions.taskFilePath !== "instructions/task.md"
    )
      throw new ArchiveError("archive_manifest_invalid");
    for (const p of m.provenance) validateProvenance(p, m.admission);
    exact(m.payload, ["contentSha256", "sizeBytes", "relativePath"]);
    if (
      !HASH.test(m.payload.contentSha256) ||
      !Number.isSafeInteger(m.payload.sizeBytes) ||
      m.payload.sizeBytes < 0 ||
      m.payload.sizeBytes > MAX_ARCHIVE_FILE_BYTES ||
      m.payload.relativePath !== "results/result.json"
    )
      throw new ArchiveError("archive_manifest_invalid");
    const seen = new Set<string>();
    let total = m.payload.sizeBytes;
    for (const item of m.items) {
      exact(item, [
        "artifactId",
        "logicalName",
        "filename",
        "required",
        "source",
        "contentSha256",
        "sizeBytes",
        "state",
        "unavailableReason",
        "relativePath",
      ]);
      portableFilename(item.filename);
      if (
        typeof item.artifactId !== "string" ||
        !item.artifactId ||
        item.artifactId.length > 128 ||
        typeof item.logicalName !== "string" ||
        item.logicalName.length > 128 ||
        typeof item.required !== "boolean" ||
        seen.has(item.artifactId)
      )
        throw new ArchiveError("archive_manifest_invalid");
      seen.add(item.artifactId);
      if (item.source) validateSource(item.source);
      if (item.state === "complete") {
        if (
          !item.source ||
          !HASH.test(item.contentSha256 ?? "") ||
          !Number.isSafeInteger(item.sizeBytes) ||
          item.sizeBytes === null ||
          item.sizeBytes < 0 ||
          item.sizeBytes > MAX_ARCHIVE_FILE_BYTES ||
          item.unavailableReason !== null ||
          item.relativePath !== `artifacts/${item.filename}`
        )
          throw new ArchiveError("archive_manifest_invalid");
        total += item.sizeBytes;
      } else if (
        item.state !== "unavailable" ||
        !ID.test(item.unavailableReason ?? "") ||
        item.relativePath !== null
      )
        throw new ArchiveError("archive_manifest_invalid");
    }
    if (
      total > MAX_ARCHIVE_TOTAL_BYTES ||
      m.complete !==
        (m.requiredSetKnown &&
          m.items.filter((i) => i.required).every((i) => i.state === "complete"))
    )
      throw new ArchiveError("archive_manifest_invalid");
  }
  async archive(
    input: ArchiveSnapshotV2,
    reader: ArchiveSourceReaderV1,
  ): Promise<ArchiveInspectionV2> {
    const snapshot = structuredClone(input),
      pin = this.pin(snapshot.requestId),
      admission = this.admission(snapshot.requestId);
    if (
      snapshot.payloadBytes.byteLength > MAX_ARCHIVE_FILE_BYTES ||
      snapshot.items.length > MAX_ARCHIVE_ENTRIES - 4
    )
      throw new ArchiveError("archive_size_limit");
    if (
      sha256Bytes(snapshot.taskSpecBytes) !== admission.taskSpecHash ||
      sha256Bytes(snapshot.taskFileBytes) !== admission.taskFileHash
    )
      throw new ArchiveError("archive_instruction_hash_mismatch");
    const keepComplete = (checked: ArchiveInspectionV2): string | null => {
      if (checked.state !== "complete" || !checked.manifest || !checked.manifestSha256) return null;
      const shape = (
        items: Pick<
          ArchiveItemV2,
          "artifactId" | "logicalName" | "required" | "source" | "contentSha256" | "sizeBytes"
        >[],
      ) =>
        items
          .map(({ artifactId, logicalName, required, source, contentSha256, sizeBytes }) => ({
            artifactId,
            logicalName,
            required,
            source,
            contentSha256,
            sizeBytes,
          }))
          .sort((a, b) => a.artifactId.localeCompare(b.artifactId));
      if (
        checked.manifest.payload.contentSha256 !== sha256Bytes(snapshot.payloadBytes) ||
        JSON.stringify(shape(checked.manifest.items)) !== JSON.stringify(shape(snapshot.items)) ||
        checked.manifest.synthetic !== snapshot.synthetic
      )
        throw new ArchiveError("archive_terminal_payload_conflict");
      return checked.manifestSha256;
    };
    const priorComplete = this.inspect(snapshot.requestId);
    if (keepComplete(priorComplete)) return priorComplete;
    const items: ArchiveItemV2[] = [],
      files: DurableFile[] = [
        { relativePath: "results/result.json", bytes: snapshot.payloadBytes },
        { relativePath: "instructions/TaskSpec.json", bytes: snapshot.taskSpecBytes },
        { relativePath: "instructions/task.md", bytes: snapshot.taskFileBytes },
      ];
    let total = files.reduce((n, f) => n + f.bytes.byteLength, 0);
    for (const item of snapshot.items) {
      const filename = `artifact-${sha256Bytes(Buffer.from(item.artifactId))}.bin`;
      const output: ArchiveItemV2 = {
        artifactId: item.artifactId,
        logicalName: item.logicalName,
        filename,
        required: item.required,
        source: item.source,
        contentSha256: item.contentSha256,
        sizeBytes: item.sizeBytes,
        state: "unavailable",
        unavailableReason: item.unavailableReason ?? "archive_source_unavailable",
        relativePath: null,
      };
      if (item.source && item.contentSha256 && item.sizeBytes !== null) {
        validateSource(item.source);
        if (
          !HASH.test(item.contentSha256) ||
          !Number.isSafeInteger(item.sizeBytes) ||
          item.sizeBytes < 0 ||
          item.sizeBytes > MAX_ARCHIVE_FILE_BYTES ||
          total + item.sizeBytes > MAX_ARCHIVE_TOTAL_BYTES
        )
          throw new ArchiveError("archive_size_limit");
        total += item.sizeBytes;
        try {
          const bytes = Uint8Array.from(
            await reader.read(item.source, {
              contentSha256: item.contentSha256,
              sizeBytes: item.sizeBytes,
            }),
          );
          if (bytes.byteLength !== item.sizeBytes || sha256Bytes(bytes) !== item.contentSha256)
            throw new ArchiveError("archive_artifact_hash_mismatch");
          output.state = "complete";
          output.unavailableReason = null;
          output.relativePath = `artifacts/${filename}`;
          files.push({ relativePath: output.relativePath, bytes });
        } catch (e) {
          output.unavailableReason =
            e instanceof ArchiveError ? e.code : "archive_source_unavailable";
        }
      }
      items.push(output);
    }
    const manifest: ArtifactArchiveManifestV2 = {
      schema: "artifact-archive-2",
      admission,
      admissionHash: pin.admissionHash,
      pin,
      provenance: this.provenance(snapshot.requestId),
      instructions: {
        taskSpecPath: "instructions/TaskSpec.json",
        taskFilePath: "instructions/task.md",
      },
      payload: {
        contentSha256: sha256Bytes(snapshot.payloadBytes),
        sizeBytes: snapshot.payloadBytes.byteLength,
        relativePath: "results/result.json",
      },
      items,
      requiredSetKnown: snapshot.requiredSetKnown,
      complete:
        snapshot.requiredSetKnown &&
        items.filter((i) => i.required).every((i) => i.state === "complete"),
      synthetic: snapshot.synthetic,
    };
    this.validateManifest(manifest, pin);
    const text = `${JSON.stringify(manifest, null, 2)}\n`,
      digest = sha256Bytes(Buffer.from(text));
    files.push({ relativePath: "manifest.json", bytes: Buffer.from(text) });
    const committedDigest = this.transaction(() => {
      const complete = keepComplete(this.inspect(snapshot.requestId));
      if (complete) return complete;
      const prior = this.db
        .prepare(
          "SELECT body FROM archive2_manifests WHERE request_id=? ORDER BY sequence DESC LIMIT 1",
        )
        .get(snapshot.requestId);
      if (prior) {
        const p = JSON.parse(String(prior.body)) as ArtifactArchiveManifestV2;
        if (p.payload.contentSha256 !== manifest.payload.contentSha256)
          throw new ArchiveError("archive_terminal_payload_conflict");
      }
      publishImmutableFiles(
        pin.localPinnedRoot,
        this.manifestDirectory(pin, digest),
        files,
        pin.rootIdentity,
        this.pathPolicy,
      );
      const seq = Number(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence),0)+1 AS seq FROM archive2_manifests WHERE request_id=?",
          )
          .get(snapshot.requestId)?.seq,
      );
      this.db
        .prepare("INSERT OR IGNORE INTO archive2_manifests VALUES (?,?,?,?)")
        .run(snapshot.requestId, seq, digest, text);
      return digest;
    });
    return this.inspect(snapshot.requestId, committedDigest);
  }
  /** Called only by the requester persistence adapter after independent materializer validation. */
  persistReceipt(
    requestId: string,
    eventId: string,
    receiptHash: string,
    body: string,
    files: DurableFile[],
  ): void {
    const pin = this.pin(requestId);
    this.transaction(() => {
      const prior = this.db
        .prepare(
          "SELECT receipt_hash,body FROM archive2_materializations WHERE request_id=? AND event_id=?",
        )
        .get(requestId, eventId);
      if (prior && (prior.receipt_hash !== receiptHash || prior.body !== body))
        throw new ArchiveError("archive_materialization_conflict");
      publishImmutableFiles(
        pin.localPinnedRoot,
        `${pin.relativeDirectory}/materialized/${receiptHash}`,
        files,
        pin.rootIdentity,
        this.pathPolicy,
      );
      this.db
        .prepare("INSERT OR IGNORE INTO archive2_materializations VALUES (?,?,?,?)")
        .run(requestId, eventId, receiptHash, body);
    });
  }
}
