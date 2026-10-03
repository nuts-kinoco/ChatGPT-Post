/** Route-local durable facts. This store never authenticates, launches or fabricates a provider result. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TextIssued } from "../adapters/sdk-text-bus.js";
import {
  parseTextRequest,
  type TextApproval,
  type TextIntent,
  type TextResult,
  validateTextBody,
} from "../contracts/sdk-text-inference.js";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
export interface TextJob {
  requestId: string;
  requestSha256: string;
  issuedPacketSha256: string;
  rawRequestBase64: string;
  markdownBase64: string;
  requesterId: string;
  recipientId: string;
  claimantId: string;
  revision: number;
  state:
    | "awaiting_approval"
    | "approved"
    | "unknown"
    | "response_received"
    | "cancelled_before_start";
  grantBase64: string | null;
  intentBase64: string | null;
  resultBase64: string | null;
  cancelledAt: string | null;
}
export class SdkTextLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly claimantId: string,
  ) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(claimantId) ||
      claimantId.length !== 36
    )
      throw new Error("text_claimant_invalid");
    db.exec(
      "PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sdk_text_jobs(id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, grant_nonce TEXT UNIQUE, revision INTEGER NOT NULL, snapshot TEXT NOT NULL);",
    );
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(id: string): TextJob | null {
    const row = this.db
      .prepare("SELECT request_hash,grant_nonce,revision,snapshot FROM sdk_text_jobs WHERE id=?")
      .get(id);
    if (!row) return null;
    const value = parseStrictJsonBytes(Buffer.from(String(row.snapshot))) as TextJob;
    const expectedKeys = [
      "requestId",
      "requestSha256",
      "issuedPacketSha256",
      "rawRequestBase64",
      "markdownBase64",
      "requesterId",
      "recipientId",
      "claimantId",
      "revision",
      "state",
      "grantBase64",
      "intentBase64",
      "resultBase64",
      "cancelledAt",
    ];
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).length !== expectedKeys.length ||
      expectedKeys.some((k) => !Object.hasOwn(value, k)) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      !/^[a-f0-9]{64}$/.test(value.issuedPacketSha256) ||
      value.issuedPacketSha256.length !== 64
    )
      throw new Error("text_ledger_corrupt");
    for (const raw of [
      value.rawRequestBase64,
      value.markdownBase64,
      value.grantBase64,
      value.intentBase64,
      value.resultBase64,
    ])
      if (
        raw !== null &&
        (typeof raw !== "string" || Buffer.from(raw, "base64").toString("base64") !== raw)
      )
        throw new Error("text_ledger_corrupt");
    const validState =
      value.state === "awaiting_approval"
        ? !value.grantBase64 && !value.intentBase64 && !value.resultBase64 && !value.cancelledAt
        : value.state === "approved"
          ? !!value.grantBase64 && !value.intentBase64 && !value.resultBase64 && !value.cancelledAt
          : value.state === "unknown"
            ? !!value.intentBase64 && !!value.grantBase64 && !value.resultBase64
            : value.state === "response_received"
              ? !!value.intentBase64 &&
                !!value.grantBase64 &&
                !!value.resultBase64 &&
                !value.cancelledAt
              : value.state === "cancelled_before_start"
                ? !value.intentBase64 && !value.resultBase64 && !!value.cancelledAt
                : false;
    if (
      !validState ||
      (value.cancelledAt !== null &&
        (!Number.isFinite(Date.parse(value.cancelledAt)) ||
          new Date(value.cancelledAt).toISOString() !== value.cancelledAt))
    )
      throw new Error("text_ledger_corrupt");
    const request = parseTextRequest(
      Buffer.from(value.rawRequestBase64, "base64"),
      Buffer.from(value.markdownBase64, "base64"),
    );
    if (
      value.requestId !== id ||
      request.requestId !== id ||
      value.requestSha256 !== row.request_hash ||
      sha256Bytes(Buffer.from(value.rawRequestBase64, "base64")) !== row.request_hash ||
      value.revision !== row.revision ||
      value.claimantId !== this.claimantId ||
      value.requesterId !== request.requesterId ||
      value.recipientId !== request.recipientId
    )
      throw new Error("text_ledger_binding_invalid");
    for (const [stage, raw] of [
      ["approval", value.grantBase64],
      ["intent", value.intentBase64],
      ["result", value.resultBase64],
    ] as const)
      if (raw) {
        const body = validateTextBody(stage, Buffer.from(raw, "base64"));
        if (
          body.requestId !== id ||
          body.requestSha256 !== value.requestSha256 ||
          body.requesterId !== value.requesterId ||
          body.recipientId !== value.recipientId
        )
          throw new Error("text_ledger_binding_invalid");
      }
    const grant = value.grantBase64
      ? (validateTextBody(
          "approval",
          Buffer.from(value.grantBase64, "base64"),
        ) as unknown as TextApproval)
      : null;
    if ((grant?.nonce ?? null) !== row.grant_nonce) throw new Error("text_ledger_nonce_mismatch");
    if (
      grant &&
      (grant.issuedPacketSha256 !== value.issuedPacketSha256 ||
        grant.policySha256 !== request.policySha256 ||
        grant.sdkProfileSha256 !== request.sdkProfileSha256 ||
        grant.taskFileSha256 !== request.taskFileSha256 ||
        Date.parse(grant.expiresAt) > Date.parse(request.expiresAt))
    )
      throw new Error("text_ledger_grant_chain_invalid");
    const intent = value.intentBase64
      ? (validateTextBody(
          "intent",
          Buffer.from(value.intentBase64, "base64"),
        ) as unknown as TextIntent)
      : null;
    if (
      intent &&
      (!grant ||
        !value.grantBase64 ||
        intent.approvalSha256 !== sha256Bytes(Buffer.from(value.grantBase64, "base64")) ||
        Date.parse(intent.createdAt) < Date.parse(grant.issuedAt) ||
        Date.parse(intent.createdAt) >= Date.parse(grant.expiresAt) ||
        Date.parse(intent.deadlineAt) > Date.parse(request.expiresAt))
    )
      throw new Error("text_ledger_intent_chain_invalid");
    const result = value.resultBase64
      ? (validateTextBody(
          "result",
          Buffer.from(value.resultBase64, "base64"),
        ) as unknown as TextResult)
      : null;
    if (
      result &&
      (!intent ||
        !value.intentBase64 ||
        result.intentSha256 !== sha256Bytes(Buffer.from(value.intentBase64, "base64")) ||
        result.attemptId !== intent.attemptId ||
        result.fence !== intent.fence ||
        Date.parse(result.finishedAt) < Date.parse(intent.createdAt) ||
        Date.parse(result.finishedAt) > Date.parse(intent.deadlineAt))
    )
      throw new Error("text_ledger_result_chain_invalid");
    return structuredClone(value);
  }
  private required(id: string) {
    const job = this.get(id);
    if (!job) throw new Error("text_request_missing");
    return job;
  }
  private save(job: TextJob) {
    job.revision++;
    const nonce = job.grantBase64
      ? (parseStrictJsonBytes(Buffer.from(job.grantBase64, "base64")) as TextApproval).nonce
      : null;
    this.db
      .prepare("UPDATE sdk_text_jobs SET grant_nonce=?,revision=?,snapshot=? WHERE id=?")
      .run(nonce, job.revision, JSON.stringify(job), job.requestId);
    return structuredClone(job);
  }
  receive(issued: TextIssued): TextJob {
    const task = parseTextRequest(issued.raw, issued.markdown);
    if (
      sha256Bytes(issued.raw) !== issued.packet.requestSha256 ||
      task.requestId !== issued.packet.requestId
    )
      throw new Error("text_admission_invalid");
    return this.transaction(() => {
      const prior = this.get(task.requestId);
      if (prior) {
        if (
          prior.requestSha256 !== issued.packet.requestSha256 ||
          prior.issuedPacketSha256 !== sha256Bytes(issued.packetBytes)
        )
          throw new Error("text_admission_conflict");
        return prior;
      }
      const job: TextJob = {
        requestId: task.requestId,
        requestSha256: issued.packet.requestSha256,
        issuedPacketSha256: sha256Bytes(issued.packetBytes),
        rawRequestBase64: Buffer.from(issued.raw).toString("base64"),
        markdownBase64: Buffer.from(issued.markdown).toString("base64"),
        requesterId: task.requesterId,
        recipientId: task.recipientId,
        claimantId: this.claimantId,
        revision: 1,
        state: "awaiting_approval",
        grantBase64: null,
        intentBase64: null,
        resultBase64: null,
        cancelledAt: null,
      };
      this.db
        .prepare("INSERT INTO sdk_text_jobs VALUES(?,?,NULL,?,?)")
        .run(job.requestId, job.requestSha256, job.revision, JSON.stringify(job));
      return structuredClone(job);
    });
  }
  /** Caller must obtain the grant from the authenticated trusted host authority. No task self-approval. */
  approve(id: string, raw: Uint8Array, now: Date): TextJob {
    const grant = validateTextBody("approval", raw) as unknown as TextApproval;
    return this.transaction(() => {
      const job = this.required(id),
        request = parseTextRequest(Buffer.from(job.rawRequestBase64, "base64"));
      if (job.cancelledAt || job.intentBase64) throw new Error("text_approval_locked");
      if (
        grant.requestId !== id ||
        grant.requestSha256 !== job.requestSha256 ||
        grant.requesterId !== job.requesterId ||
        grant.recipientId !== job.recipientId ||
        grant.issuedPacketSha256 !== job.issuedPacketSha256 ||
        grant.policySha256 !== request.policySha256 ||
        grant.sdkProfileSha256 !== request.sdkProfileSha256 ||
        grant.taskFileSha256 !== request.taskFileSha256 ||
        Date.parse(grant.issuedAt) > now.getTime() ||
        Date.parse(grant.expiresAt) <= now.getTime() ||
        Date.parse(grant.expiresAt) > Date.parse(request.expiresAt)
      )
        throw new Error("text_approval_binding_invalid");
      const encoded = Buffer.from(raw).toString("base64");
      if (job.grantBase64) {
        if (job.grantBase64 !== encoded) throw new Error("text_approval_conflict");
        return job;
      }
      job.grantBase64 = encoded;
      job.state = "approved";
      return this.save(job);
    });
  }
  /** Atomic one-attempt reservation only. Actual driver still requires the private valid launch lease. */
  reserveStart(
    id: string,
    evidence: { probeEvidenceSha256: string; sdkOptionsSha256: string; attemptId?: string },
    now: Date,
    signal?: AbortSignal,
  ): { job: TextJob; created: boolean } {
    return this.transaction(() => {
      const job = this.required(id);
      if (job.intentBase64) return { job, created: false };
      if (signal?.aborted || job.cancelledAt) throw new Error("text_dispatch_stopped");
      if (job.state !== "approved" || !job.grantBase64) throw new Error("text_approval_required");
      const grant = validateTextBody(
        "approval",
        Buffer.from(job.grantBase64, "base64"),
      ) as unknown as TextApproval;
      const request = parseTextRequest(Buffer.from(job.rawRequestBase64, "base64"));
      if (
        Date.parse(grant.issuedAt) > now.getTime() ||
        Date.parse(grant.expiresAt) <= now.getTime() ||
        Date.parse(request.expiresAt) <= now.getTime()
      )
        throw new Error("text_approval_expired");
      const intent: TextIntent = {
        schema: "sdk-text-intent-1",
        requestId: id,
        requestSha256: job.requestSha256,
        requesterId: job.requesterId,
        recipientId: job.recipientId,
        attemptId: evidence.attemptId ?? randomUUID(),
        fence: 1,
        sdkVersion: "0.3.287",
        executionProfile: "official-sdk-managed",
        approvalSha256: sha256Bytes(Buffer.from(job.grantBase64, "base64")),
        probeEvidenceSha256: evidence.probeEvidenceSha256,
        sdkOptionsSha256: evidence.sdkOptionsSha256,
        createdAt: now.toISOString(),
        deadlineAt: new Date(
          Math.min(now.getTime() + 60000, Date.parse(request.expiresAt)),
        ).toISOString(),
      };
      const raw = Buffer.from(JSON.stringify(intent));
      validateTextBody("intent", raw);
      job.intentBase64 = raw.toString("base64");
      job.state = "unknown";
      return { job: this.save(job), created: true };
    });
  }
  cancel(id: string, now: Date): TextJob {
    return this.transaction(() => {
      const job = this.required(id);
      if (job.cancelledAt || job.resultBase64) return job;
      job.cancelledAt = now.toISOString();
      job.state = job.intentBase64 ? "unknown" : "cancelled_before_start";
      return this.save(job);
    });
  }
  saveResult(id: string, raw: Uint8Array): TextJob {
    const result = validateTextBody("result", raw) as unknown as TextResult;
    return this.transaction(() => {
      const job = this.required(id);
      if (!job.intentBase64) throw new Error("text_intent_missing");
      const intent = validateTextBody(
        "intent",
        Buffer.from(job.intentBase64, "base64"),
      ) as unknown as TextIntent;
      if (
        job.cancelledAt ||
        result.requestId !== id ||
        result.requestSha256 !== job.requestSha256 ||
        result.requesterId !== job.requesterId ||
        result.recipientId !== job.recipientId ||
        result.attemptId !== intent.attemptId ||
        result.intentSha256 !== sha256Bytes(Buffer.from(job.intentBase64, "base64")) ||
        Date.parse(result.finishedAt) < Date.parse(intent.createdAt) ||
        Date.parse(result.finishedAt) > Date.parse(intent.deadlineAt)
      )
        throw new Error("text_result_binding_invalid");
      const encoded = Buffer.from(raw).toString("base64");
      if (job.resultBase64) {
        if (job.resultBase64 !== encoded) throw new Error("text_result_conflict");
        return job;
      }
      job.resultBase64 = encoded;
      job.state = "response_received";
      return this.save(job);
    });
  }
}
