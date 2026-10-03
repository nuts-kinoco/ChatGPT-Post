/** Requester-owned storage pin is committed before any remote issuance. No execution/auth authority. */
import type { DatabaseSync } from "node:sqlite";
import type { GitHubSdkTextBus } from "../adapters/sdk-text-bus.js";
import { assertRootIdentity, type OwnedRootIdentity, rootIdentity } from "../archive/durable.js";
import type { PathPolicy } from "../archive/paths.js";
import type {
  ProjectRegistrationReference,
  ProjectRegistryPort,
} from "../contracts/project-registry.js";
import { parseTextRequest, type TextRequest } from "../contracts/sdk-text-inference.js";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
export interface TextRequesterPin {
  schema: "sdk-text-requester-pin-1";
  requestId: string;
  requestSha256: string;
  requesterId: string;
  projectRegistration: ProjectRegistrationReference;
  repoId: string;
  root: string;
  identity: OwnedRootIdentity;
  createdAt: string;
}
export class SdkTextRequesterJournal {
  constructor(
    private readonly db: DatabaseSync,
    private readonly registry: ProjectRegistryPort,
    private readonly requesterId: string,
    private readonly pathPolicy: PathPolicy = {},
  ) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(requesterId) || requesterId.length > 64)
      throw new Error("text_requester_identity_invalid");
    db.exec(
      "PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sdk_text_requester_pins(id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, request BLOB NOT NULL, pin BLOB NOT NULL);",
    );
  }
  private mapping(request: TextRequest): string {
    const ref = request.projectRegistration;
    if (this.registry.snapshotHash(ref.registryRevision) !== ref.snapshotSha256)
      throw new Error("text_requester_registry_mismatch");
    const project = this.registry.resolve(ref.registryRevision, request.repoId);
    const root =
      project.outputRootOverride ?? this.registry.defaultOutputRoot(ref.registryRevision);
    if (project.projectId !== ref.projectId || !root || request.requesterId !== this.requesterId)
      throw new Error("text_requester_pin_mismatch");
    return root;
  }
  get(id: string): TextRequesterPin | null {
    const row = this.db
      .prepare("SELECT request_hash,request,pin FROM sdk_text_requester_pins WHERE id=?")
      .get(id);
    if (!row) return null;
    if (
      !(row.request instanceof Uint8Array) ||
      !(row.pin instanceof Uint8Array) ||
      row.pin.byteLength > 16384 ||
      sha256Bytes(row.request) !== row.request_hash
    )
      throw new Error("text_requester_pin_corrupt");
    const request = parseTextRequest(row.request),
      p = parseStrictJsonBytes(row.pin) as TextRequesterPin;
    const keys = [
      "schema",
      "requestId",
      "requestSha256",
      "requesterId",
      "projectRegistration",
      "repoId",
      "root",
      "identity",
      "createdAt",
    ];
    if (
      !p ||
      typeof p !== "object" ||
      Array.isArray(p) ||
      Object.keys(p).length !== keys.length ||
      keys.some((k) => !Object.hasOwn(p, k)) ||
      p.schema !== "sdk-text-requester-pin-1" ||
      p.requestId !== id ||
      request.requestId !== id ||
      p.requestSha256 !== row.request_hash ||
      p.requesterId !== this.requesterId ||
      p.repoId !== request.repoId ||
      p.root !== this.mapping(request) ||
      JSON.stringify(p.projectRegistration) !== JSON.stringify(request.projectRegistration) ||
      !p.identity ||
      Object.keys(p.identity).sort().join(",") !== "device,inode" ||
      [p.identity.device, p.identity.inode].some(
        (v) => typeof v !== "string" || v.length > 30 || !/^\d+$/.test(v),
      ) ||
      typeof p.createdAt !== "string" ||
      !Number.isFinite(Date.parse(p.createdAt)) ||
      new Date(p.createdAt).toISOString() !== p.createdAt
    )
      throw new Error("text_requester_pin_corrupt");
    assertRootIdentity(p.root, p.identity, this.pathPolicy);
    return structuredClone(p);
  }
  private pin(raw: Uint8Array, markdown: Uint8Array, now: Date): TextRequesterPin {
    const bytes = Buffer.from(raw),
      request = parseTextRequest(bytes, markdown),
      hash = sha256Bytes(bytes);
    if (request.requesterId !== this.requesterId) throw new Error("text_requester_pin_mismatch");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.get(request.requestId);
      if (prior) {
        if (prior.requestSha256 !== hash) throw new Error("text_requester_pin_conflict");
        this.db.exec("COMMIT");
        return prior;
      }
      if (this.registry.currentRevision() !== request.projectRegistration.registryRevision)
        throw new Error("text_requester_registry_stale");
      const root = this.mapping(request),
        identity = rootIdentity(root, this.pathPolicy);
      const pin: TextRequesterPin = {
        schema: "sdk-text-requester-pin-1",
        requestId: request.requestId,
        requestSha256: hash,
        requesterId: this.requesterId,
        projectRegistration: structuredClone(request.projectRegistration),
        repoId: request.repoId,
        root,
        identity,
        createdAt: now.toISOString(),
      };
      this.db
        .prepare("INSERT INTO sdk_text_requester_pins VALUES(?,?,?,?)")
        .run(request.requestId, hash, bytes, Buffer.from(JSON.stringify(pin)));
      if (
        this.registry.currentRevision() !== request.projectRegistration.registryRevision ||
        this.mapping(request) !== root
      )
        throw new Error("text_requester_registry_stale");
      assertRootIdentity(root, identity, this.pathPolicy);
      this.db.exec("COMMIT");
      return structuredClone(pin);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Explicit preparation only. Existing external issuance cannot be silently adopted into a later root. */
  async prepareIssue(
    bus: GitHubSdkTextBus,
    raw: Uint8Array,
    markdown: Uint8Array,
    now: Date,
  ): Promise<TextRequesterPin> {
    const requestBytes = Buffer.from(raw),
      md = Buffer.from(markdown),
      request = parseTextRequest(requestBytes, md);
    if (bus.bus.registry !== this.registry || bus.bus.codec.signer.actorId !== this.requesterId)
      throw new Error("text_requester_context_mismatch");
    if (!this.get(request.requestId)) {
      try {
        await bus.read(request.requestId);
        throw new Error("text_requester_existing_issue_unpinned");
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "text_request_missing") throw error;
      }
    }
    return this.pin(requestBytes, md, now);
  }
  async issue(
    bus: GitHubSdkTextBus,
    raw: Uint8Array,
    markdown: Uint8Array,
    now: Date,
  ): Promise<string> {
    const request = Buffer.from(raw),
      md = Buffer.from(markdown);
    if (bus.bus.registry !== this.registry || bus.bus.codec.signer.actorId !== this.requesterId)
      throw new Error("text_requester_context_mismatch");
    await this.prepareIssue(bus, request, md, now);
    return bus.issue(request, md);
  }
  async collect(bus: GitHubSdkTextBus, id: string, now: Date, expectedResultSha256?: string) {
    if (bus.bus.registry !== this.registry || bus.bus.codec.signer.actorId !== this.requesterId)
      throw new Error("text_requester_context_mismatch");
    const pin = this.get(id);
    if (!pin) throw new Error("text_requester_pin_required");
    return bus.materializeAndAccept(id, pin, now, this.pathPolicy, expectedResultSha256);
  }
}
