/** Signed append-only GitHub bus. Git author names and PR text are never authorization.
 * Ed25519 signing is supplied by an already-authorized host signer. This code creates no keys.
 */

import { createPublicKey, randomUUID, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { assertDeliveryBinding, assertMaterializationProof } from "../contracts/delivery-proof.js";
import {
  type DeliveryBindingV1,
  type DeliveryManifestV1,
  type MaterializationReceiptV1,
  parseDeliveryManifestV1,
  parseMaterializationReceiptV1,
  serializeDeliveryManifestV1,
  serializeMaterializationReceiptV1,
  validateMaterializationReceiptV1,
} from "../contracts/materialization.js";
import {
  type OutputContractV1,
  outputContractDigest,
  parseOutputContractV1,
} from "../contracts/output-contract.js";
import type {
  ProjectRegistrationReference,
  ProjectRegistryPort,
} from "../contracts/project-registry.js";
import {
  loadTaskSpec,
  parseStrictJsonBytes,
  sha256Bytes,
  verifyTaskFileBytes,
} from "../contracts/task.js";
import type { TaskController } from "../state/task-controller.js";
import type { TaskHandshake } from "../state/task-store.js";
import type { GitObjectStore, GitSnapshot } from "./github-client.js";

export interface MessageSigner {
  readonly actorId: string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}
export interface BusIdentity {
  actorId: string;
  publicKeyPem: string;
  roles: readonly ("requester" | "recipient")[];
}
interface SignedEnvelope {
  version: "bridge-bus-1";
  actorId: string;
  payload: string;
  signature: string;
}
export interface IssuedMessage {
  kind: "issued";
  /** Absent only for historical candidate bytes; historical issuance cannot be executed. */
  version?: "bridge-issued-2";
  outputContractSha256?: string | null;
  fanoutId: string | null;
  projectRegistration: ProjectRegistrationReference | null;
  repoId: string;
  projectSlug: string;
  requestId: string;
  taskSpecHash: string;
  taskFileHash: string;
  requesterId: string;
  recipientId: string;
  route: "cli" | "ordinary_chat_browser";
}
interface ClaimMessage {
  kind: "claim";
  claimantId: string;
  requestId: string;
  taskSpecHash: string;
  recipientId: string;
}
interface EventMessage {
  kind: "handshake";
  event: TaskHandshake;
}
export interface HostedEvent {
  version: "hosted-response-1";
  requestId: string;
  taskSpecHash: string;
  eventId: string;
  actorId: string;
  payloadSha256: string;
  stage: "hosted_result" | "hosted_ack";
}
export interface FanoutMessage {
  kind: "fanout";
  fanoutId: string;
  requesterId: string;
  children: {
    requestId: string;
    taskSpecHash: string;
    recipientId: string;
    route: IssuedMessage["route"];
  }[];
}
interface HostedMessage {
  kind: "hosted";
  event: HostedEvent;
}
interface OutputContractMessage {
  kind: "output_contract";
  rawBody: string;
}
interface ManifestMessage {
  kind: "delivery_manifest";
  manifest: DeliveryManifestV1;
}
interface MaterializationMessage {
  kind: "materialization";
  receipt: MaterializationReceiptV1;
}
export interface DeliveryAcceptanceContext {
  issued: IssuedMessage;
  rawTaskSpec: Uint8Array;
  taskFileBytes: Uint8Array;
  terminalEvent: TaskHandshake | HostedEvent;
  payloadBytes: Uint8Array;
  manifest: DeliveryManifestV1;
  signedManifestBytes: Uint8Array;
  outputContractRaw: Uint8Array | null;
}
type BusMessage =
  | IssuedMessage
  | ClaimMessage
  | EventMessage
  | HostedMessage
  | FanoutMessage
  | ManifestMessage
  | MaterializationMessage
  | OutputContractMessage;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const actor = /^[a-z][a-z0-9_-]{0,63}$/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("transport_message_invalid");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((k) => !Object.hasOwn(value, k)))
    throw new Error("transport_message_invalid");
}
export class SignedBusCodec {
  private readonly identities: Map<string, BusIdentity>;
  constructor(
    identities: readonly BusIdentity[],
    readonly signer: MessageSigner,
    private readonly signerTimeoutMs = 5000,
  ) {
    if (!Number.isSafeInteger(signerTimeoutMs) || signerTimeoutMs < 1 || signerTimeoutMs > 30000)
      throw new Error("transport_signer_timeout_invalid");
    this.identities = new Map(identities.map((i) => [i.actorId, structuredClone(i)]));
    if (this.identities.size !== identities.length || !this.identities.has(signer.actorId))
      throw new Error("transport_identity_unconfigured");
    for (const identity of identities) {
      if (
        !actor.test(identity.actorId) ||
        createPublicKey(identity.publicKeyPem).asymmetricKeyType !== "ed25519"
      )
        throw new Error("transport_identity_invalid");
    }
  }
  role(actorId: string, role: "requester" | "recipient") {
    if (!this.identities.get(actorId)?.roles.includes(role))
      throw new Error("transport_actor_denied");
  }
  async encode(message: BusMessage): Promise<Uint8Array> {
    const raw = Buffer.from(JSON.stringify(message));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let signature: Uint8Array;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("transport_signer_timeout")),
          this.signerTimeoutMs,
        );
      });
      signature = await Promise.race([this.signer.sign(raw), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // A timed-out encode is rejected permanently. A late signer result cannot publish anything.
    const envelope: SignedEnvelope = {
      version: "bridge-bus-1",
      actorId: this.signer.actorId,
      payload: raw.toString("base64"),
      signature: Buffer.from(signature).toString("base64"),
    };
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
    this.decode(bytes); // A misconfigured host signer must fail before publication.
    return bytes;
  }
  decode(bytes: Uint8Array): { actorId: string; message: BusMessage } {
    if (bytes.length > 524288) throw new Error("transport_message_too_large");
    const envelope = record(parseStrictJsonBytes(bytes));
    exactKeys(envelope, ["version", "actorId", "payload", "signature"]);
    if (
      envelope.version !== "bridge-bus-1" ||
      typeof envelope.actorId !== "string" ||
      typeof envelope.payload !== "string" ||
      typeof envelope.signature !== "string"
    )
      throw new Error("transport_message_invalid");
    const identity = this.identities.get(envelope.actorId);
    const raw = Buffer.from(envelope.payload, "base64");
    const signature = Buffer.from(envelope.signature, "base64");
    if (
      !identity ||
      raw.toString("base64") !== envelope.payload ||
      signature.toString("base64") !== envelope.signature ||
      signature.length !== 64 ||
      !verify(null, raw, identity.publicKeyPem, signature)
    )
      throw new Error("transport_signature_invalid");
    const data = record(parseStrictJsonBytes(raw));
    if (data.kind === "issued") {
      exactKeys(data, [
        "kind",
        ...(data.version === "bridge-issued-2" ? ["version", "outputContractSha256"] : []),
        "fanoutId",
        "projectRegistration",
        "repoId",
        "projectSlug",
        "requestId",
        "taskSpecHash",
        "taskFileHash",
        "requesterId",
        "recipientId",
        "route",
      ]);
      if (
        data.version === "bridge-issued-2" &&
        data.outputContractSha256 !== null &&
        (typeof data.outputContractSha256 !== "string" || !hash.test(data.outputContractSha256))
      )
        throw new Error("transport_output_contract_hash_invalid");
      if (
        data.requesterId !== identity.actorId ||
        (data.fanoutId !== null &&
          (typeof data.fanoutId !== "string" || !uuid.test(data.fanoutId))) ||
        typeof data.repoId !== "string" ||
        !actor.test(data.repoId) ||
        typeof data.projectSlug !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(data.projectSlug) ||
        typeof data.recipientId !== "string" ||
        !actor.test(data.recipientId) ||
        !["cli", "ordinary_chat_browser"].includes(String(data.route)) ||
        typeof data.taskFileHash !== "string" ||
        !hash.test(data.taskFileHash)
      )
        throw new Error("transport_issued_invalid");
      if (data.projectRegistration !== null) {
        const registration = record(data.projectRegistration);
        exactKeys(registration, ["projectId", "registryRevision", "snapshotSha256"]);
        if (
          typeof registration.projectId !== "string" ||
          !uuid.test(registration.projectId) ||
          !Number.isSafeInteger(registration.registryRevision) ||
          Number(registration.registryRevision) < 1 ||
          typeof registration.snapshotSha256 !== "string" ||
          !hash.test(registration.snapshotSha256)
        )
          throw new Error("transport_project_registration_invalid");
      }
      this.role(identity.actorId, "requester");
      this.role(data.recipientId, "recipient");
    } else if (data.kind === "fanout") {
      exactKeys(data, ["kind", "fanoutId", "requesterId", "children"]);
      if (
        data.requesterId !== identity.actorId ||
        typeof data.fanoutId !== "string" ||
        !uuid.test(data.fanoutId) ||
        !Array.isArray(data.children) ||
        data.children.length < 2 ||
        data.children.length > 4
      )
        throw new Error("transport_fanout_invalid");
      this.role(identity.actorId, "requester");
      const ids = new Set<string>();
      for (const child of data.children) {
        const entry = record(child);
        exactKeys(entry, ["requestId", "taskSpecHash", "recipientId", "route"]);
        if (
          typeof entry.requestId !== "string" ||
          !uuid.test(entry.requestId) ||
          ids.has(entry.requestId) ||
          entry.requestId === data.fanoutId ||
          typeof entry.taskSpecHash !== "string" ||
          !hash.test(entry.taskSpecHash) ||
          typeof entry.recipientId !== "string" ||
          !["cli", "ordinary_chat_browser"].includes(String(entry.route))
        )
          throw new Error("transport_fanout_invalid");
        this.role(entry.recipientId, "recipient");
        ids.add(entry.requestId);
      }
      return { actorId: identity.actorId, message: data as unknown as FanoutMessage };
    } else if (data.kind === "output_contract") {
      exactKeys(data, ["kind", "rawBody"]);
      if (typeof data.rawBody !== "string") throw new Error("transport_output_contract_invalid");
      const raw = Buffer.from(data.rawBody, "base64");
      if (raw.toString("base64") !== data.rawBody)
        throw new Error("transport_output_contract_invalid");
      const contract = parseOutputContractV1(raw);
      if (contract.requesterActorId !== identity.actorId)
        throw new Error("transport_output_contract_actor_denied");
      this.role(identity.actorId, "requester");
      return {
        actorId: identity.actorId,
        message: { kind: "output_contract", rawBody: data.rawBody },
      };
    } else if (data.kind === "delivery_manifest") {
      exactKeys(data, ["kind", "manifest"]);
      const manifest = parseDeliveryManifestV1(Buffer.from(JSON.stringify(data.manifest)));
      if (manifest.recipientActorId !== identity.actorId)
        throw new Error("transport_manifest_actor_denied");
      this.role(identity.actorId, "recipient");
      return { actorId: identity.actorId, message: { kind: "delivery_manifest", manifest } };
    } else if (data.kind === "materialization") {
      exactKeys(data, ["kind", "receipt"]);
      const receipt = validateMaterializationReceiptV1(data.receipt);
      if (receipt.requesterActorId !== identity.actorId)
        throw new Error("transport_materialization_actor_denied");
      this.role(identity.actorId, "requester");
      return { actorId: identity.actorId, message: { kind: "materialization", receipt } };
    } else if (data.kind === "claim") {
      exactKeys(data, ["kind", "claimantId", "requestId", "taskSpecHash", "recipientId"]);
      if (typeof data.claimantId !== "string" || !uuid.test(data.claimantId))
        throw new Error("transport_claim_invalid");
      if (data.recipientId !== identity.actorId) throw new Error("transport_claim_invalid");
      this.role(identity.actorId, "recipient");
    } else if (data.kind === "hosted") {
      exactKeys(data, ["kind", "event"]);
      const event = record(data.event);
      exactKeys(event, [
        "version",
        "requestId",
        "taskSpecHash",
        "eventId",
        "actorId",
        "payloadSha256",
        "stage",
      ]);
      if (
        event.version !== "hosted-response-1" ||
        event.actorId !== identity.actorId ||
        typeof event.requestId !== "string" ||
        !uuid.test(event.requestId) ||
        typeof event.taskSpecHash !== "string" ||
        !hash.test(event.taskSpecHash) ||
        typeof event.payloadSha256 !== "string" ||
        !hash.test(event.payloadSha256) ||
        typeof event.eventId !== "string" ||
        !uuid.test(event.eventId) ||
        !["hosted_result", "hosted_ack"].includes(String(event.stage))
      )
        throw new Error("transport_hosted_event_invalid");
      this.role(identity.actorId, event.stage === "hosted_ack" ? "requester" : "recipient");
      return { actorId: identity.actorId, message: data as unknown as HostedMessage };
    } else if (data.kind === "handshake") {
      exactKeys(data, ["kind", "event"]);
      const event = record(data.event);
      exactKeys(event, [
        "eventId",
        "stage",
        "requestId",
        "taskSpecHash",
        "runId",
        "sequence",
        "actorId",
        "payloadSha256",
        "fencingToken",
        "startIntentSequence",
        "processIdentity",
      ]);
      if (
        event.actorId !== identity.actorId ||
        typeof event.requestId !== "string" ||
        !uuid.test(event.requestId) ||
        typeof event.taskSpecHash !== "string" ||
        !hash.test(event.taskSpecHash) ||
        typeof event.payloadSha256 !== "string" ||
        !hash.test(event.payloadSha256) ||
        typeof event.eventId !== "string" ||
        !uuid.test(event.eventId) ||
        !["receipt_ack", "start_receipt", "terminal_result", "result_ack"].includes(
          String(event.stage),
        ) ||
        !Number.isSafeInteger(event.sequence) ||
        Number(event.sequence) < 1 ||
        !Number.isSafeInteger(event.fencingToken) ||
        Number(event.fencingToken) < 0 ||
        (event.runId !== null && (typeof event.runId !== "string" || !uuid.test(event.runId))) ||
        (event.startIntentSequence !== null &&
          (!Number.isSafeInteger(event.startIntentSequence) ||
            Number(event.startIntentSequence) < 1))
      )
        throw new Error("transport_event_invalid");
      if (event.processIdentity !== null) {
        const process = record(event.processIdentity);
        exactKeys(process, [
          "host_id",
          "boot_id",
          "pid",
          "creation_time",
          "executable_sha256",
          "process_group_id",
        ]);
        if (
          typeof process.host_id !== "string" ||
          !actor.test(process.host_id) ||
          typeof process.boot_id !== "string" ||
          !uuid.test(process.boot_id) ||
          !Number.isSafeInteger(process.pid) ||
          Number(process.pid) < 1 ||
          typeof process.creation_time !== "string" ||
          !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z(?![\s\S])/.test(
            process.creation_time,
          ) ||
          !Number.isFinite(Date.parse(process.creation_time)) ||
          typeof process.executable_sha256 !== "string" ||
          !hash.test(process.executable_sha256) ||
          typeof process.process_group_id !== "string" ||
          process.process_group_id.length < 1 ||
          process.process_group_id.length > 128
        )
          throw new Error("transport_process_identity_invalid");
      }
      if (
        event.runId === null &&
        (event.fencingToken !== 0 ||
          event.startIntentSequence !== null ||
          event.processIdentity !== null)
      )
        throw new Error("transport_event_run_mismatch");
      if (
        event.runId !== null &&
        (Number(event.fencingToken) < 1 ||
          event.startIntentSequence === null ||
          Number(event.startIntentSequence) >= Number(event.sequence))
      )
        throw new Error("transport_event_run_mismatch");
      if (event.stage === "receipt_ack" && (event.runId !== null || event.sequence !== 1))
        throw new Error("transport_receipt_stage_invalid");
      if (
        event.stage === "start_receipt" &&
        (event.runId === null || event.processIdentity === null)
      )
        throw new Error("transport_start_evidence_missing");
      this.role(identity.actorId, event.stage === "result_ack" ? "requester" : "recipient");
      return { actorId: identity.actorId, message: data as unknown as EventMessage };
    } else throw new Error("transport_message_kind_denied");
    if (
      typeof data.requestId !== "string" ||
      !uuid.test(data.requestId) ||
      typeof data.taskSpecHash !== "string" ||
      !hash.test(data.taskSpecHash)
    )
      throw new Error("transport_request_identity_invalid");
    return { actorId: identity.actorId, message: data as unknown as BusMessage };
  }
}
export class TransportJournal {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS bridge_transport (key TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, retry_at INTEGER NOT NULL, error TEXT); CREATE TABLE IF NOT EXISTS bridge_transport_cursor (name TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
  }
  get claimantId(): string {
    this.db
      .prepare("INSERT OR IGNORE INTO bridge_transport_cursor VALUES ('claimant', ?)")
      .run(randomUUID());
    const value = this.cursor("claimant");
    if (!uuid.test(value)) throw new Error("transport_claimant_invalid");
    return value;
  }
  due(key: string, digest: string, now: number): boolean {
    const row = this.db
      .prepare("SELECT digest,state,retry_at FROM bridge_transport WHERE key=?")
      .get(key) as { digest: string; state: string; retry_at: number } | undefined;
    if (row && row.digest !== digest) throw new Error("transport_replay_conflict");
    return !row || (row.state !== "done" && row.retry_at <= now);
  }
  done(key: string, digest: string) {
    this.db
      .prepare(
        "INSERT INTO bridge_transport VALUES (?,?, 'done',0,0,NULL) ON CONFLICT(key) DO UPDATE SET state='done',error=NULL",
      )
      .run(key, digest);
  }
  failed(key: string, digest: string, now: number, code: string) {
    const row = this.db.prepare("SELECT attempts FROM bridge_transport WHERE key=?").get(key) as
      | { attempts: number }
      | undefined;
    const attempts = (row?.attempts ?? 0) + 1;
    const retryAt = now + Math.min(300000, 1000 * 2 ** Math.min(attempts, 8));
    this.db
      .prepare(
        "INSERT INTO bridge_transport VALUES (?,?,'pending',?,?,?) ON CONFLICT(key) DO UPDATE SET attempts=?,retry_at=?,error=?",
      )
      .run(key, digest, attempts, retryAt, code, attempts, retryAt, code);
  }
  cursor(name: string): string {
    return (
      (
        this.db.prepare("SELECT value FROM bridge_transport_cursor WHERE name=?").get(name) as
          | { value: string }
          | undefined
      )?.value ?? ""
    );
  }
  advance(name: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO bridge_transport_cursor VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=?",
      )
      .run(name, value, value);
  }
  close() {
    this.db.close();
  }
}
export class GitHubTaskBus {
  private readonly requestProjects = new Map<string, string>();
  private readonly projects: Readonly<Record<string, string>>;
  constructor(
    readonly git: GitObjectStore,
    readonly codec: SignedBusCodec,
    readonly prefix = "bridge-v2",
    projects: Readonly<Record<string, string>> = {},
    readonly registry?: ProjectRegistryPort,
  ) {
    if (!/^[a-z0-9-]{1,64}$/.test(prefix)) throw new Error("transport_prefix_invalid");
    const names = new Set<string>();
    for (const [repo, slug] of Object.entries(projects)) {
      if (
        !actor.test(repo) ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(slug) ||
        names.has(slug.toLowerCase())
      )
        throw new Error("transport_project_registry_invalid");
      names.add(slug.toLowerCase());
    }
    this.projects = Object.freeze({ ...projects });
  }
  private bindProject(
    requestId: string,
    repoId: string,
    projectSlug: string,
    reference: ProjectRegistrationReference | null,
  ): void {
    if (reference) {
      if (!this.registry) throw new Error("transport_registry_history_required");
      const project = this.registry.resolve(reference.registryRevision, repoId);
      if (
        project.projectId !== reference.projectId ||
        project.storageSlug !== projectSlug ||
        this.registry.snapshotHash(reference.registryRevision) !== reference.snapshotSha256
      )
        throw new Error("transport_registry_binding_mismatch");
      if (
        !project.githubDestination ||
        project.githubDestination.namespace !== this.prefix ||
        project.githubDestination.repositoryFullName !== this.git.destination?.repositoryFullName ||
        project.githubDestination.branch !== this.git.destination?.branch
      )
        throw new Error("transport_registered_destination_mismatch");
    } else if (
      this.registry ||
      !Object.hasOwn(this.projects, repoId) ||
      this.projects[repoId] !== projectSlug
    )
      throw new Error("transport_project_not_registered");
    const prior = this.requestProjects.get(requestId);
    if (prior && prior !== projectSlug) throw new Error("transport_request_project_conflict");
    this.requestProjects.set(requestId, projectSlug);
  }
  path(kind: string, requestId: string, name: string) {
    if (!uuid.test(requestId)) throw new Error("transport_request_identity_invalid");
    if (kind === "inbox" && name === "issued.json")
      return `${this.prefix}/request-index/${requestId}.json`;
    if (
      !["inbox", "claims", "outbox", "hosted"].includes(kind) ||
      !/^[a-z_]+\.(json|md)$/.test(name)
    )
      throw new Error("transport_path_denied");
    const slug = this.requestProjects.get(requestId);
    if (!slug) throw new Error("transport_project_identity_missing");
    return `${this.prefix}/projects/${slug}/requests/${requestId}/${name}`;
  }
  private async ensureProject(requestId: string, snapshot?: GitSnapshot): Promise<void> {
    if (!this.requestProjects.has(requestId))
      await this.readIssued(
        snapshot ?? (await this.git.snapshot()),
        this.path("inbox", requestId, "issued.json"),
      );
  }
  async prepareIssue(
    raw: Uint8Array,
    taskBytes: Uint8Array,
    recipientId: string,
    route: IssuedMessage["route"] = "cli",
    fanoutId: string | null = null,
    outputContractRaw?: Uint8Array,
    expectedProjectRegistration?: ProjectRegistrationReference,
  ): Promise<{ issued: IssuedMessage; files: Map<string, Uint8Array> }> {
    const parsed = loadTaskSpec(raw);
    if (!parsed.valid || !verifyTaskFileBytes(parsed.task, taskBytes).valid)
      throw new Error("transport_task_invalid");
    const revision = this.registry?.currentRevision();
    const registered = revision ? this.registry?.resolve(revision, parsed.task.repo) : undefined;
    const projectRegistration: ProjectRegistrationReference | null =
      registered && revision && this.registry
        ? {
            projectId: registered.projectId,
            registryRevision: revision,
            snapshotSha256: this.registry.snapshotHash(revision),
          }
        : null;
    if (
      expectedProjectRegistration &&
      !isDeepStrictEqual(expectedProjectRegistration, projectRegistration)
    )
      throw new Error("transport_project_preview_stale");
    const projectSlug =
      registered?.storageSlug ??
      (Object.hasOwn(this.projects, parsed.task.repo)
        ? this.projects[parsed.task.repo]
        : undefined);
    if (!projectSlug) throw new Error("transport_project_not_registered");
    this.bindProject(parsed.task.request_id, parsed.task.repo, projectSlug, projectRegistration);
    const issued: IssuedMessage = {
      kind: "issued",
      version: "bridge-issued-2",
      outputContractSha256: outputContractRaw ? outputContractDigest(outputContractRaw) : null,
      fanoutId,
      projectRegistration,
      repoId: parsed.task.repo,
      projectSlug,
      requestId: parsed.task.request_id,
      taskSpecHash: parsed.taskSpecHash,
      taskFileHash: parsed.task.task_file_hash,
      requesterId: this.codec.signer.actorId,
      recipientId,
      route,
    };
    if (route === "ordinary_chat_browser") {
      if (!outputContractRaw) throw new Error("output_contract_required");
      this.validateOutputContract(issued, outputContractRaw, raw);
    } else if (outputContractRaw) throw new Error("output_contract_route_unsupported");
    const envelope = await this.codec.encode(issued);
    const files = new Map<string, Uint8Array>([
      [this.path("inbox", issued.requestId, "issued.json"), envelope],
      [this.path("outbox", issued.requestId, "issued.json"), envelope],
      [this.path("inbox", issued.requestId, "task.json"), raw],
      [this.path("inbox", issued.requestId, "task.md"), taskBytes],
    ]);
    if (outputContractRaw)
      files.set(
        this.path("inbox", issued.requestId, "output_contract.json"),
        await this.codec.encode({
          kind: "output_contract",
          rawBody: Buffer.from(outputContractRaw).toString("base64"),
        }),
      );
    return { issued, files };
  }
  async issue(
    raw: Uint8Array,
    taskBytes: Uint8Array,
    recipientId: string,
    route: IssuedMessage["route"] = "cli",
    outputContractRaw?: Uint8Array,
    expectedProjectRegistration?: ProjectRegistrationReference,
  ): Promise<string> {
    const { issued, files } = await this.prepareIssue(
      raw,
      taskBytes,
      recipientId,
      route,
      null,
      outputContractRaw,
      expectedProjectRegistration,
    );
    this.assertPreparedIssueCurrent(issued);
    return this.git.append(files, `Bridge request ${issued.requestId}`);
  }
  /** Linearizes the chosen preview before append starts; later edits affect later issuance only. */
  assertPreparedIssueCurrent(issued: IssuedMessage): void {
    const ref = issued.projectRegistration;
    if (
      ref &&
      (!this.registry ||
        this.registry.currentRevision() !== ref.registryRevision ||
        this.registry.snapshotHash(ref.registryRevision) !== ref.snapshotSha256)
    )
      throw new Error("transport_project_preview_stale");
    this.bindProject(issued.requestId, issued.repoId, issued.projectSlug, ref);
  }
  async readIssued(
    snapshot: GitSnapshot,
    path: string,
  ): Promise<{
    issued: IssuedMessage;
    raw: Uint8Array;
    taskBytes: Uint8Array;
    outputContractRaw: Uint8Array | null;
    outputContract: OutputContractV1 | null;
  }> {
    const bytes = await this.git.read(snapshot, path);
    if (!bytes) throw new Error("transport_issued_missing");
    const { message } = this.codec.decode(bytes);
    if (message.kind !== "issued" || path !== this.path("inbox", message.requestId, "issued.json"))
      throw new Error("transport_issued_path_mismatch");
    this.bindProject(
      message.requestId,
      message.repoId,
      message.projectSlug,
      message.projectRegistration,
    );
    const localIssued = await this.git.read(
      snapshot,
      this.path("outbox", message.requestId, "issued.json"),
    );
    if (!localIssued || !Buffer.from(localIssued).equals(Buffer.from(bytes)))
      throw new Error("transport_project_index_mismatch");
    const raw = await this.git.read(snapshot, this.path("inbox", message.requestId, "task.json"));
    const taskBytes = await this.git.read(
      snapshot,
      this.path("inbox", message.requestId, "task.md"),
    );
    if (
      !raw ||
      !taskBytes ||
      sha256Bytes(raw) !== message.taskSpecHash ||
      sha256Bytes(taskBytes) !== message.taskFileHash
    )
      throw new Error("transport_payload_hash_mismatch");
    const parsed = loadTaskSpec(raw);
    if (
      !parsed.valid ||
      parsed.task.repo !== message.repoId ||
      parsed.task.request_id !== message.requestId
    )
      throw new Error("transport_task_project_mismatch");
    let outputContractRaw: Uint8Array | null = null;
    let outputContract: OutputContractV1 | null = null;
    if (message.version === "bridge-issued-2" && message.route === "ordinary_chat_browser") {
      const signed = await this.git.read(
        snapshot,
        this.path("inbox", message.requestId, "output_contract.json"),
      );
      if (!signed) throw new Error("output_contract_required");
      const decoded = this.codec.decode(signed).message;
      if (decoded.kind !== "output_contract") throw new Error("transport_output_contract_invalid");
      outputContractRaw = Buffer.from(decoded.rawBody, "base64");
      outputContract = this.validateOutputContract(message, outputContractRaw, raw);
    } else if (message.outputContractSha256) throw new Error("output_contract_route_unsupported");
    return { issued: message, raw, taskBytes, outputContractRaw, outputContract };
  }
  private validateOutputContract(
    issued: IssuedMessage,
    rawContract: Uint8Array,
    rawTask: Uint8Array,
  ): OutputContractV1 {
    const contract = parseOutputContractV1(rawContract);
    const task = loadTaskSpec(rawTask);
    const ref = issued.projectRegistration;
    if (
      !task.valid ||
      !ref ||
      !this.registry ||
      issued.version !== "bridge-issued-2" ||
      issued.route !== "ordinary_chat_browser"
    )
      throw new Error("output_contract_registration_required");
    const project = this.registry.resolve(ref.registryRevision, issued.repoId);
    if (
      outputContractDigest(rawContract) !== issued.outputContractSha256 ||
      contract.requestId !== issued.requestId ||
      contract.taskSpecHash !== issued.taskSpecHash ||
      contract.taskFileHash !== issued.taskFileHash ||
      contract.requesterActorId !== issued.requesterId ||
      contract.recipientActorId !== issued.recipientId ||
      contract.policySnapshotSha256 !== task.task.policy_snapshot_sha256 ||
      contract.registryRevision !== ref.registryRevision ||
      contract.registrySnapshotSha256 !== ref.snapshotSha256 ||
      contract.projectId !== ref.projectId ||
      contract.repoId !== issued.repoId ||
      contract.storageSlug !== issued.projectSlug ||
      !project.githubDestination ||
      contract.destination.repositoryFullName !== project.githubDestination.repositoryFullName ||
      contract.destination.branch !== project.githubDestination.branch ||
      contract.destination.namespace !== project.githubDestination.namespace
    )
      throw new Error("output_contract_binding_mismatch");
    return contract;
  }
  async claim(issued: IssuedMessage, claimantId: string): Promise<string> {
    if (issued.version !== "bridge-issued-2")
      throw new Error("transport_legacy_issuance_not_executable");
    await this.ensureProject(issued.requestId);
    if (issued.recipientId !== this.codec.signer.actorId)
      throw new Error("transport_recipient_denied");
    const bytes = await this.codec.encode({
      kind: "claim",
      claimantId,
      requestId: issued.requestId,
      taskSpecHash: issued.taskSpecHash,
      recipientId: issued.recipientId,
    });
    return this.git.append(
      new Map([[this.path("claims", issued.requestId, "claim.json"), bytes]]),
      `Bridge claim ${issued.requestId}`,
    );
  }
  private async authenticateEvent(
    snapshot: GitSnapshot,
    event: TaskHandshake | HostedEvent,
    route: IssuedMessage["route"],
  ): Promise<void> {
    const { issued } = await this.readIssued(
      snapshot,
      this.path("inbox", event.requestId, "issued.json"),
    );
    const ack = event.stage === "result_ack" || event.stage === "hosted_ack";
    if (
      issued.route !== route ||
      event.taskSpecHash !== issued.taskSpecHash ||
      event.actorId !== (ack ? issued.requesterId : issued.recipientId)
    )
      throw new Error("transport_event_issued_binding_mismatch");
  }
  async publish(event: TaskHandshake, resultBytes?: Uint8Array): Promise<string> {
    if (event.stage === "result_ack") throw new Error("transport_ack_requires_materialization");
    await this.ensureProject(event.requestId);
    await this.authenticateEvent(await this.git.snapshot(), event, "cli");
    const files = new Map([
      [
        this.path("outbox", event.requestId, `${event.stage}.json`),
        await this.codec.encode({ kind: "handshake", event }),
      ],
    ]);
    if (event.stage === "terminal_result") {
      if (!resultBytes || sha256Bytes(resultBytes) !== event.payloadSha256)
        throw new Error("transport_result_hash_mismatch");
      files.set(this.path("outbox", event.requestId, "result.json"), resultBytes);
    } else if (resultBytes) throw new Error("transport_unexpected_payload");
    return this.git.append(files, `Bridge ${event.stage} ${event.requestId}`);
  }
  async publishHosted(event: HostedEvent, bytes?: Uint8Array): Promise<string> {
    if (event.stage === "hosted_ack") throw new Error("transport_ack_requires_materialization");
    await this.ensureProject(event.requestId);
    await this.authenticateEvent(await this.git.snapshot(), event, "ordinary_chat_browser");
    const files = new Map([
      [
        this.path("hosted", event.requestId, `${event.stage}.json`),
        await this.codec.encode({ kind: "hosted", event }),
      ],
    ]);
    if (event.stage === "hosted_result") {
      if (!bytes || sha256Bytes(bytes) !== event.payloadSha256)
        throw new Error("transport_result_hash_mismatch");
      files.set(this.path("hosted", event.requestId, "response.json"), bytes);
    } else if (bytes) throw new Error("transport_unexpected_payload");
    return this.git.append(files, `Bridge ${event.stage} ${event.requestId}`);
  }
  async readHosted(
    snapshot: GitSnapshot,
    requestId: string,
    stage: HostedEvent["stage"],
  ): Promise<HostedEvent | null> {
    await this.ensureProject(requestId, snapshot);
    const bytes = await this.git.read(snapshot, this.path("hosted", requestId, `${stage}.json`));
    if (!bytes) return null;
    const { message } = this.codec.decode(bytes);
    if (
      message.kind !== "hosted" ||
      message.event.stage !== stage ||
      message.event.requestId !== requestId
    )
      throw new Error("transport_event_path_mismatch");
    await this.authenticateEvent(snapshot, message.event, "ordinary_chat_browser");
    if (stage === "hosted_ack") {
      const proof = await this.readMaterialization(snapshot, requestId);
      const terminal = await this.readHosted(snapshot, requestId, "hosted_result");
      if (
        !terminal ||
        !isDeepStrictEqual(message.event, {
          ...terminal,
          stage: "hosted_ack",
          actorId: proof.requesterActorId,
        })
      )
        throw new Error("delivery_identity_mismatch");
    }
    return message.event;
  }
  async acceptHosted(
    requestId: string,
    accept: (
      bytes: Uint8Array,
      event: HostedEvent,
      context: DeliveryAcceptanceContext,
    ) => Promise<MaterializationReceiptV1 | undefined>,
  ): Promise<string> {
    return this.acceptMaterialized(requestId, "ordinary_chat_browser", async (context) =>
      accept(context.payloadBytes, context.terminalEvent as HostedEvent, context),
    );
  }
  async readEvent(
    snapshot: GitSnapshot,
    requestId: string,
    stage: TaskHandshake["stage"],
  ): Promise<TaskHandshake | null> {
    await this.ensureProject(requestId, snapshot);
    const bytes = await this.git.read(snapshot, this.path("outbox", requestId, `${stage}.json`));
    if (!bytes) return null;
    const { message } = this.codec.decode(bytes);
    if (
      message.kind !== "handshake" ||
      message.event.requestId !== requestId ||
      message.event.stage !== stage
    )
      throw new Error("transport_event_path_mismatch");
    await this.authenticateEvent(snapshot, message.event, "cli");
    if (stage === "result_ack") {
      const proof = await this.readMaterialization(snapshot, requestId);
      const terminal = await this.readEvent(snapshot, requestId, "terminal_result");
      if (
        !terminal ||
        !isDeepStrictEqual(message.event, {
          ...terminal,
          stage: "result_ack",
          actorId: proof.requesterActorId,
        })
      )
        throw new Error("delivery_identity_mismatch");
    }
    return message.event;
  }
  /** The trusted requester materializer must verify and durably save exact bytes before returning proof. */
  async acceptResult(
    requestId: string,
    accept: (
      bytes: Uint8Array,
      event: TaskHandshake,
      context: DeliveryAcceptanceContext,
    ) => Promise<MaterializationReceiptV1 | undefined>,
  ): Promise<string> {
    return this.acceptMaterialized(requestId, "cli", async (context) =>
      accept(context.payloadBytes, context.terminalEvent as TaskHandshake, context),
    );
  }
  private binding(
    issued: IssuedMessage,
    event: TaskHandshake | HostedEvent,
    payload: Uint8Array,
  ): DeliveryBindingV1 {
    if (
      event.actorId !== issued.recipientId ||
      event.requestId !== issued.requestId ||
      event.taskSpecHash !== issued.taskSpecHash ||
      sha256Bytes(payload) !== event.payloadSha256
    )
      throw new Error("transport_result_unverified");
    const value = record(parseStrictJsonBytes(payload));
    const execution =
      issued.route === "cli"
        ? { kind: "local_execution" as const, runId: (event as TaskHandshake).runId }
        : { kind: "hosted_delivery" as const, attemptId: String(value.attemptId ?? "") };
    if (execution.kind === "hosted_delivery" && !uuid.test(execution.attemptId))
      throw new Error("transport_hosted_attempt_missing");
    return {
      requesterActorId: issued.requesterId,
      recipientActorId: issued.recipientId,
      requestId: issued.requestId,
      taskSpecHash: issued.taskSpecHash,
      execution,
      terminalEventId: event.eventId,
      payloadSha256: event.payloadSha256,
    };
  }
  async deliveryContext(
    snapshot: GitSnapshot,
    requestId: string,
  ): Promise<DeliveryAcceptanceContext> {
    await this.ensureProject(requestId, snapshot);
    const { issued, raw, taskBytes, outputContractRaw } = await this.readIssued(
      snapshot,
      this.path("inbox", requestId, "issued.json"),
    );
    if (issued.version !== "bridge-issued-2")
      throw new Error("transport_legacy_delivery_insufficient");
    const hosted = issued.route === "ordinary_chat_browser";
    const event = hosted
      ? await this.readHosted(snapshot, requestId, "hosted_result")
      : await this.readEvent(snapshot, requestId, "terminal_result");
    const payload = await this.git.read(
      snapshot,
      this.path(hosted ? "hosted" : "outbox", requestId, hosted ? "response.json" : "result.json"),
    );
    if (!event || !payload) throw new Error("transport_result_unverified");
    const binding = this.binding(issued, event, payload);
    const signedManifestBytes = await this.git.read(
      snapshot,
      this.path("outbox", requestId, "delivery_manifest.json"),
    );
    if (!signedManifestBytes) throw new Error("delivery_manifest_required");
    const { message } = this.codec.decode(signedManifestBytes);
    if (message.kind !== "delivery_manifest") throw new Error("delivery_manifest_invalid");
    assertDeliveryBinding(message.manifest, binding);
    if (message.manifest.payload.sizeBytes !== payload.length)
      throw new Error("delivery_payload_size_mismatch");
    return {
      issued,
      rawTaskSpec: raw,
      taskFileBytes: taskBytes,
      terminalEvent: event,
      payloadBytes: payload,
      manifest: message.manifest,
      signedManifestBytes,
      outputContractRaw,
    };
  }
  /** Called only after explicit configured artifact publication; never uploads raw refs implicitly. */
  async publishManifest(manifest: DeliveryManifestV1): Promise<string> {
    serializeDeliveryManifestV1(manifest);
    const snapshot = await this.git.snapshot();
    await this.ensureProject(manifest.requestId, snapshot);
    const { issued } = await this.readIssued(
      snapshot,
      this.path("inbox", manifest.requestId, "issued.json"),
    );
    if (issued.version !== "bridge-issued-2")
      throw new Error("transport_legacy_delivery_insufficient");
    if (issued.recipientId !== this.codec.signer.actorId)
      throw new Error("transport_recipient_denied");
    const hosted = issued.route === "ordinary_chat_browser";
    const event = hosted
      ? await this.readHosted(snapshot, manifest.requestId, "hosted_result")
      : await this.readEvent(snapshot, manifest.requestId, "terminal_result");
    const payload = await this.git.read(
      snapshot,
      this.path(
        hosted ? "hosted" : "outbox",
        manifest.requestId,
        hosted ? "response.json" : "result.json",
      ),
    );
    if (!event || !payload) throw new Error("transport_result_unverified");
    assertDeliveryBinding(manifest, this.binding(issued, event, payload));
    if (manifest.payload.sizeBytes !== payload.length)
      throw new Error("delivery_payload_size_mismatch");
    return this.git.append(
      new Map([
        [
          this.path("outbox", manifest.requestId, "delivery_manifest.json"),
          await this.codec.encode({
            kind: "delivery_manifest",
            manifest: parseDeliveryManifestV1(Buffer.from(serializeDeliveryManifestV1(manifest))),
          }),
        ],
      ]),
      `Bridge manifest ${manifest.requestId}`,
    );
  }
  async readMaterialization(
    snapshot: GitSnapshot,
    requestId: string,
  ): Promise<MaterializationReceiptV1> {
    const context = await this.deliveryContext(snapshot, requestId);
    const bytes = await this.git.read(
      snapshot,
      this.path("outbox", requestId, "materialization.json"),
    );
    if (!bytes) throw new Error("delivery_materialization_required");
    const { message } = this.codec.decode(bytes);
    if (message.kind !== "materialization") throw new Error("delivery_materialization_invalid");
    assertMaterializationProof(
      message.receipt,
      context.manifest,
      this.binding(context.issued, context.terminalEvent, context.payloadBytes),
    );
    this.checkReceiptScope(message.receipt, context);
    return message.receipt;
  }
  private checkReceiptScope(
    receipt: MaterializationReceiptV1,
    context: DeliveryAcceptanceContext,
  ): void {
    const payload = record(parseStrictJsonBytes(context.payloadBytes));
    if (receipt.synthetic !== (payload.synthetic === true))
      throw new Error("delivery_proof_scope_mismatch");
  }
  private async acceptMaterialized(
    requestId: string,
    route: IssuedMessage["route"],
    accept: (context: DeliveryAcceptanceContext) => Promise<MaterializationReceiptV1 | undefined>,
  ): Promise<string> {
    const snapshot = await this.git.snapshot();
    const context = await this.deliveryContext(snapshot, requestId);
    if (context.issued.requesterId !== this.codec.signer.actorId || context.issued.route !== route)
      throw new Error("transport_requester_denied");
    const returned = await accept(structuredClone(context));
    const receipt = returned
      ? parseMaterializationReceiptV1(Buffer.from(serializeMaterializationReceiptV1(returned)))
      : undefined;
    if (!receipt) throw new Error("delivery_materialization_required");
    assertMaterializationProof(
      receipt,
      context.manifest,
      this.binding(context.issued, context.terminalEvent, context.payloadBytes),
    );
    this.checkReceiptScope(receipt, context);
    const hosted = route === "ordinary_chat_browser";
    const stage = hosted ? ("hosted_ack" as const) : ("result_ack" as const);
    const event = { ...context.terminalEvent, stage, actorId: this.codec.signer.actorId };
    const signedAck = hosted
      ? await this.codec.encode({ kind: "hosted", event: event as HostedEvent })
      : await this.codec.encode({ kind: "handshake", event: event as TaskHandshake });
    // One atomic immutable commit: no ACK without matching requester proof, and retry reuses exact bytes.
    return this.git.append(
      new Map([
        [
          this.path("outbox", requestId, "materialization.json"),
          await this.codec.encode({ kind: "materialization", receipt }),
        ],
        [this.path(hosted ? "hosted" : "outbox", requestId, `${stage}.json`), signedAck],
      ]),
      `Bridge materialized ACK ${requestId}`,
    );
  }
}
export interface TransportTick {
  received: string[];
  delivered: string[];
  acknowledged: string[];
  blocked: { requestId: string; reason: string }[];
}
export class GitHubRecipientPump {
  constructor(
    readonly bus: GitHubTaskBus,
    readonly controller: TaskController,
    readonly journal: TransportJournal,
    readonly now = () => Date.now(),
    readonly maxPerTick = 32,
  ) {
    if (
      maxPerTick < 1 ||
      maxPerTick > 256 ||
      !Number.isInteger(maxPerTick) ||
      controller.policy.bridgeId !== bus.codec.signer.actorId
    )
      throw new Error("transport_runtime_invalid");
  }
  /** One bounded reconciliation tick. Scheduling is a host responsibility; no auto-start here.
   * Safe to repeat after any crash. Git claim precedes local admission; local intent owns starts. */
  async tick(): Promise<TransportTick> {
    const result: TransportTick = { received: [], delivered: [], acknowledged: [], blocked: [] };
    const snapshot = await this.bus.git.snapshot();
    const paths = [...snapshot.files.keys()]
      .filter((p) => p.startsWith(`${this.bus.prefix}/request-index/`) && p.endsWith(".json"))
      .sort();
    const cursor = this.journal.cursor("inbox");
    const ordered = [...paths.filter((p) => p > cursor), ...paths.filter((p) => p <= cursor)].slice(
      0,
      this.maxPerTick,
    );
    for (const path of ordered) {
      const digest = snapshot.files.get(path) ?? "";
      let requestId =
        path
          .split("/")
          .at(-1)
          ?.replace(/\.json$/, "") ?? "unknown";
      try {
        if (!this.journal.due(path, digest, this.now())) continue;
        const { issued, raw, taskBytes } = await this.bus.readIssued(snapshot, path);
        requestId = issued.requestId;
        if (issued.recipientId !== this.bus.codec.signer.actorId) continue;
        if (issued.route !== "cli")
          throw new Error("ordinary_chat_requires_browser_delivery_adapter");
        await this.bus.claim(issued, this.journal.claimantId);
        this.controller.receive(raw, taskBytes, `${snapshot.commit}:${path}`, issued.requesterId, {
          projectRegistration: issued.projectRegistration,
        });
        this.journal.done(path, digest);
        result.received.push(requestId);
      } catch (error) {
        const reason = safeCode(error);
        this.journal.failed(path, digest, this.now(), reason);
        result.blocked.push({ requestId, reason });
      } finally {
        this.journal.advance("inbox", path);
      }
    }
    const sessionTasks = this.controller.store
      .listSession(this.controller.policy.sessionId)
      .sort((a, b) => a.result.request_id.localeCompare(b.result.request_id));
    const outboxCursor = this.journal.cursor("outbox");
    const outboxTasks = [
      ...sessionTasks.filter((t) => t.result.request_id > outboxCursor),
      ...sessionTasks.filter((t) => t.result.request_id <= outboxCursor),
    ].slice(0, this.maxPerTick);
    for (const task of outboxTasks) {
      const requestId = task.result.request_id;
      try {
        const issuedPath = this.bus.path("inbox", requestId, "issued.json");
        if (
          !task.transportRequestId?.endsWith(`:${issuedPath}`) ||
          !/^[0-9a-f]{40}:/.test(task.transportRequestId)
        )
          continue;
        const source = await this.bus.readIssued(snapshot, issuedPath);
        if (
          source.issued.route !== "cli" ||
          source.issued.requesterId !== task.requesterId ||
          source.issued.recipientId !== this.bus.codec.signer.actorId ||
          source.issued.taskSpecHash !== task.result.task_spec_hash ||
          Buffer.from(source.raw).toString("utf8") !== task.rawSpec
        )
          throw new Error("transport_publication_binding_mismatch");
        for (const stage of ["receipt_ack", "start_receipt", "terminal_result"] as const) {
          const event = this.controller.store.handshake(requestId, stage);
          if (!event) continue;
          const key = `send:${event.eventId}`;
          if (!this.journal.due(key, event.payloadSha256, this.now())) continue;
          try {
            await this.bus.publish(
              event,
              stage === "terminal_result"
                ? this.controller.store.deliveryPayload(requestId)
                : undefined,
            );
            this.journal.done(key, event.payloadSha256);
            result.delivered.push(`${requestId}:${stage}`);
          } catch (error) {
            this.journal.failed(key, event.payloadSha256, this.now(), safeCode(error));
            throw error;
          }
        }
        const ack = await this.bus.readEvent(snapshot, requestId, "result_ack");
        if (ack && !this.controller.store.deliveryVerified(requestId)) {
          await this.controller.acknowledgeResult(
            ack,
            await this.bus.readMaterialization(snapshot, requestId),
          );
          result.acknowledged.push(requestId);
        }
      } catch (error) {
        result.blocked.push({ requestId, reason: safeCode(error) });
      } finally {
        this.journal.advance("outbox", requestId);
      }
    }
    return result;
  }
}
function safeCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "transport_unknown";
  return /^[a-z_0-9]+$/.test(value) ? value : "transport_operation_failed";
}
