/** Explicit extension of the existing signed Git bus. No model/process/credential operations. */

import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  type OwnedRootIdentity,
  publishImmutableFiles,
  verifyImmutableFiles,
} from "../archive/durable.js";
import { archivePath, type PathPolicy, readOwnedFile } from "../archive/paths.js";
import {
  parseTextRequest,
  TEXT_BUNDLE_FILES,
  type TextAcceptance,
  type TextBinding,
  type TextPacket,
  type TextRequest,
  type TextStage,
  textPacket,
} from "../contracts/sdk-text-inference.js";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
import type { GitSnapshot } from "./github-client.js";
import type { GitHubTaskBus } from "./github-transport.js";
export interface TextIssued {
  request: TextRequest;
  raw: Uint8Array;
  markdown: Uint8Array;
  packet: TextPacket;
  packetBytes: Uint8Array;
  root: string;
  commit: string;
}
export class GitHubSdkTextBus {
  constructor(readonly bus: GitHubTaskBus) {}
  private mapping(request: TextRequest, current = false): string {
    const registry = this.bus.registry;
    if (!registry) throw new Error("text_registry_required");
    const ref = request.projectRegistration;
    if (
      (current && registry.currentRevision() !== ref.registryRevision) ||
      registry.snapshotHash(ref.registryRevision) !== ref.snapshotSha256
    )
      throw new Error("text_registry_stale");
    const project = registry.resolve(ref.registryRevision, request.repoId);
    if (
      project.projectId !== ref.projectId ||
      project.repoId !== request.repoId ||
      !isDeepStrictEqual(project.githubDestination, request.destination) ||
      request.destination.namespace !== this.bus.prefix
    )
      throw new Error("text_destination_mismatch");
    const destination = this.bus.git.destination;
    if (
      !destination ||
      destination.repositoryFullName !== request.destination.repositoryFullName ||
      destination.branch !== request.destination.branch
    )
      throw new Error("text_destination_mismatch");
    return `${this.bus.prefix}/projects/${project.storageSlug}/requests/${request.requestId}`;
  }
  private index(id: string): string {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id) ||
      id.length !== 36
    )
      throw new Error("text_request_id_invalid");
    return `${this.bus.prefix}/request-index/${id}.json`;
  }
  async issue(raw: Uint8Array, markdown: Uint8Array): Promise<string> {
    raw = Buffer.from(raw);
    markdown = Buffer.from(markdown);
    const request = parseTextRequest(raw, markdown),
      root = this.mapping(request, true);
    if (this.bus.codec.signer.actorId !== request.requesterId)
      throw new Error("text_requester_mismatch");
    const packet = textPacket(
      "issued",
      {
        requestId: request.requestId,
        requestSha256: sha256Bytes(raw),
        requesterId: request.requesterId,
        recipientId: request.recipientId,
      },
      raw,
    );
    const bytes = await this.bus.codec.encode(packet);
    this.mapping(request, true);
    return this.bus.git.append(
      new Map([
        [this.index(request.requestId), bytes],
        [`${root}/issued.json`, bytes],
        [`${root}/task.json`, Buffer.from(raw)],
        [`${root}/task.md`, Buffer.from(markdown)],
      ]),
      "Bridge text inference issue",
    );
  }
  async read(id: string, snapshot?: GitSnapshot): Promise<TextIssued> {
    const s = snapshot ?? (await this.bus.git.snapshot()),
      bytes = await this.bus.git.read(s, this.index(id));
    if (!bytes) throw new Error("text_request_missing");
    const decoded = this.bus.codec.decode(bytes);
    if (decoded.message.kind !== "text_inference" || decoded.message.stage !== "issued")
      throw new Error("text_route_mismatch");
    const packet = decoded.message;
    if (packet.requestId !== id) throw new Error("text_request_mismatch");
    const request = parseTextRequest(Buffer.from(packet.bodyBase64, "base64")),
      root = this.mapping(request);
    const [raw, md, issued] = await Promise.all([
      this.bus.git.read(s, `${root}/task.json`),
      this.bus.git.read(s, `${root}/task.md`),
      this.bus.git.read(s, `${root}/issued.json`),
    ]);
    if (
      !raw ||
      !md ||
      !issued ||
      sha256Bytes(raw) !== packet.requestSha256 ||
      sha256Bytes(issued) !== sha256Bytes(bytes)
    )
      throw new Error("text_issued_binding_invalid");
    parseTextRequest(raw, md);
    return { request, raw, markdown: md, packet, packetBytes: bytes, root, commit: s.commit };
  }
  async readStage(
    id: string,
    stage: Exclude<TextStage, "issued">,
    snapshot?: GitSnapshot,
  ): Promise<{ packet: TextPacket; bytes: Uint8Array } | null> {
    const s = snapshot ?? (await this.bus.git.snapshot()),
      issued = await this.read(id, s),
      bytes = await this.bus.git.read(s, `${issued.root}/text-${stage}.json`);
    if (!bytes) return null;
    const { message } = this.bus.codec.decode(bytes);
    if (
      message.kind !== "text_inference" ||
      message.stage !== stage ||
      message.requestId !== id ||
      message.requestSha256 !== issued.packet.requestSha256 ||
      message.requesterId !== issued.request.requesterId ||
      message.recipientId !== issued.request.recipientId
    )
      throw new Error("text_stage_binding_invalid");
    await this.checkChain(issued, message, s);
    if (stage === "acceptance") {
      const ack = await this.bus.git.read(s, `${issued.root}/text-ack.json`);
      if (!ack || sha256Bytes(ack) !== sha256Bytes(bytes)) throw new Error("text_ack_incomplete");
    }
    return { packet: message, bytes };
  }
  async publish(
    id: string,
    stage: Exclude<TextStage, "issued" | "acceptance">,
    body: Uint8Array,
  ): Promise<string> {
    const issued = await this.read(id);
    const binding: TextBinding = {
      requestId: id,
      requestSha256: issued.packet.requestSha256,
      requesterId: issued.request.requesterId,
      recipientId: issued.request.recipientId,
    };
    const packet = textPacket(stage, binding, body);
    await this.checkChain(issued, packet, await this.bus.git.snapshot());
    const bytes = await this.bus.codec.encode(packet);
    return this.bus.git.append(
      new Map([[`${issued.root}/text-${stage}.json`, bytes]]),
      `Bridge text inference ${stage}`,
    );
  }
  private async checkChain(
    issued: TextIssued,
    packet: TextPacket,
    snapshot: GitSnapshot,
  ): Promise<void> {
    const body = parseStrictJsonBytes(Buffer.from(packet.bodyBase64, "base64")) as Record<
      string,
      unknown
    >;
    const fail = () => {
      throw new Error("text_stage_chain_invalid");
    };
    if (packet.stage === "approval") {
      const claim = await this.readStage(issued.request.requestId, "claim", snapshot);
      if (
        !claim ||
        body.issuedPacketSha256 !== sha256Bytes(issued.packetBytes) ||
        body.taskFileSha256 !== issued.request.taskFileSha256 ||
        body.policySha256 !== issued.request.policySha256 ||
        body.sdkProfileSha256 !== issued.request.sdkProfileSha256 ||
        Date.parse(String(body.expiresAt)) > Date.parse(issued.request.expiresAt)
      )
        fail();
    }
    if (packet.stage === "intent") {
      const approval = await this.readStage(issued.request.requestId, "approval", snapshot);
      if (!approval) return fail();
      const grant = parseStrictJsonBytes(
        Buffer.from(approval.packet.bodyBase64, "base64"),
      ) as Record<string, unknown>;
      if (
        body.approvalSha256 !== approval.packet.bodySha256 ||
        Date.parse(String(body.createdAt)) < Date.parse(String(grant.issuedAt)) ||
        Date.parse(String(body.createdAt)) >= Date.parse(String(grant.expiresAt)) ||
        Date.parse(String(body.deadlineAt)) > Date.parse(issued.request.expiresAt)
      )
        fail();
    }
    if (packet.stage === "result") {
      const intent = await this.readStage(issued.request.requestId, "intent", snapshot);
      if (!intent) return fail();
      const start = parseStrictJsonBytes(Buffer.from(intent.packet.bodyBase64, "base64")) as Record<
        string,
        unknown
      >;
      if (
        body.intentSha256 !== intent.packet.bodySha256 ||
        body.attemptId !== start.attemptId ||
        body.fence !== start.fence ||
        Date.parse(String(body.finishedAt)) < Date.parse(String(start.createdAt)) ||
        Date.parse(String(body.finishedAt)) > Date.parse(String(start.deadlineAt))
      )
        fail();
    }
    if (packet.stage === "acceptance") {
      const result = await this.readStage(issued.request.requestId, "result", snapshot);
      if (!result) return fail();
      const terminal = parseStrictJsonBytes(
        Buffer.from(result.packet.bodyBase64, "base64"),
      ) as Record<string, unknown>;
      const files = await this.bundle(issued, snapshot),
        descriptors = files.map((f) => ({
          name: f.relativePath,
          sha256: sha256Bytes(f.bytes),
          sizeBytes: f.bytes.length,
        }));
      if (
        body.resultSha256 !== result.packet.bodySha256 ||
        body.attemptId !== terminal.attemptId ||
        body.fence !== terminal.fence ||
        !isDeepStrictEqual(body.verifiedFiles, descriptors) ||
        body.bundleSha256 !== sha256Bytes(Buffer.from(JSON.stringify(descriptors)))
      )
        fail();
    }
  }
  private async bundle(issued: TextIssued, snapshot: GitSnapshot) {
    const approval = await this.readStage(issued.request.requestId, "approval", snapshot),
      intent = await this.readStage(issued.request.requestId, "intent", snapshot),
      result = await this.readStage(issued.request.requestId, "result", snapshot);
    if (!approval || !intent || !result) throw new Error("text_bundle_incomplete");
    const resultBytes = Buffer.from(result.packet.bodyBase64, "base64"),
      terminal = parseStrictJsonBytes(resultBytes) as Record<string, unknown>;
    const bytes = [
      issued.raw,
      issued.markdown,
      issued.packetBytes,
      approval.bytes,
      intent.bytes,
      resultBytes,
      result.bytes,
      Buffer.from(JSON.stringify(terminal.observation)),
    ];
    return TEXT_BUNDLE_FILES.map((relativePath, i) => ({
      relativePath,
      bytes: bytes[i] as Uint8Array,
    }));
  }
  /** Explicit requester action: durable fixed bytes first, then one atomic signed proof+ACK commit. */
  async materializeAndAccept(
    id: string,
    pin: { root: string; identity: OwnedRootIdentity; requestSha256: string; requesterId: string },
    now: Date,
    pathPolicy: PathPolicy = {},
    expectedResultSha256?: string,
  ) {
    const snapshot = await this.bus.git.snapshot(),
      issued = await this.read(id, snapshot);
    if (
      this.bus.codec.signer.actorId !== issued.request.requesterId ||
      pin.requesterId !== issued.request.requesterId ||
      pin.requestSha256 !== issued.packet.requestSha256
    )
      throw new Error("text_requester_pin_mismatch");
    const registry = this.bus.registry;
    if (!registry) throw new Error("text_registry_required");
    const p = registry.resolve(
        issued.request.projectRegistration.registryRevision,
        issued.request.repoId,
      ),
      root =
        p.outputRootOverride ??
        registry.defaultOutputRoot(issued.request.projectRegistration.registryRevision);
    if (root !== pin.root) throw new Error("text_requester_root_mismatch");
    const files = await this.bundle(issued, snapshot),
      descriptors = files.map((f) => ({
        name: f.relativePath as (typeof TEXT_BUNDLE_FILES)[number],
        sha256: sha256Bytes(f.bytes),
        sizeBytes: f.bytes.length,
      }));
    const digest = sha256Bytes(Buffer.from(JSON.stringify(descriptors))),
      result = await this.readStage(id, "result", snapshot);
    if (!result) throw new Error("text_result_missing");
    if (expectedResultSha256 !== undefined && result.packet.bodySha256 !== expectedResultSha256)
      throw new Error("sdk_text_result_hash_mismatch");
    const terminal = parseStrictJsonBytes(
      Buffer.from(result.packet.bodyBase64, "base64"),
    ) as Record<string, unknown>;
    const acceptance: TextAcceptance = {
      schema: "sdk-text-acceptance-1",
      requestId: id,
      requestSha256: issued.packet.requestSha256,
      requesterId: issued.request.requesterId,
      recipientId: issued.request.recipientId,
      attemptId: String(terminal.attemptId),
      fence: 1,
      resultSha256: result.packet.bodySha256,
      bundleSha256: digest,
      verifiedFiles: descriptors,
      requiredArtifactsVerified: true,
      savedAt: now.toISOString(),
    };
    const prior = await this.readStage(id, "acceptance", snapshot);
    const directory = `ChatGPT-Bridge/projects/${p.storageSlug}/requests/${id}/text-materialized/${digest}`;
    const savedPath = archivePath(pin.root, `${directory}/acceptance.json`);
    const body = prior
      ? Buffer.from(prior.packet.bodyBase64, "base64")
      : existsSync(savedPath)
        ? readOwnedFile(savedPath, 65536, pathPolicy)
        : Buffer.from(JSON.stringify(acceptance));
    const packet = textPacket("acceptance", issued.packet, body);
    const durable = [...files, { relativePath: "acceptance.json", bytes: body }];
    publishImmutableFiles(pin.root, directory, durable, pin.identity, pathPolicy);
    verifyImmutableFiles(pin.root, directory, durable, pin.identity, pathPolicy);
    await this.checkChain(issued, packet, snapshot);
    const signed = prior?.bytes ?? (await this.bus.codec.encode(packet));
    const commit = await this.bus.git.append(
      new Map([
        [`${issued.root}/text-acceptance.json`, signed],
        [`${issued.root}/text-ack.json`, signed],
      ]),
      "Bridge verified text acceptance",
    );
    return { commit, bundleSha256: digest, resultSha256: result.packet.bodySha256 };
  }
}
