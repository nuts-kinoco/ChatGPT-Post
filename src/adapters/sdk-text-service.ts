/** Explicit SDK text dispatch. Local reads/reconcile never start a query; unknown never reexecutes. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  assertRootIdentity,
  type OwnedRootIdentity,
  publishImmutableFiles,
  rootIdentity,
  verifyImmutableFiles,
} from "../archive/durable.js";
import { archivePath, type PathPolicy, readOwnedFile } from "../archive/paths.js";
import {
  parseTextRequest,
  type TextApproval,
  type TextIntent,
  type TextResult,
  validateTextBody,
} from "../contracts/sdk-text-inference.js";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
import type { SdkTextLedger, TextJob } from "../state/sdk-text-ledger.js";
import { ClaudeSdkMessages } from "./claude-sdk-messages.js";
import {
  type ClaudeSdkHostProfile,
  type ClaudeSdkProbeObservation,
  cloneClaudeSdkHostProfile,
  probeClaudeSdkHost,
} from "./claude-sdk-profile.js";
import {
  loadOfficialSdkTextAdapter,
  prepareSdkTextPlan,
  type SdkTextAdapter,
  type SdkTextOutcome,
  type SdkTextRun,
  sdkProfileDigest,
} from "./claude-sdk-text.js";
import type { GitHubSdkTextBus } from "./sdk-text-bus.js";
export interface SdkTextApprovalAuthority {
  /** Trusted host policy only. No request/model readiness flag or credentials are accepted here. */
  approve(input: {
    requestId: string;
    requestSha256: string;
    profileSha256: string;
    approverId: string;
    expiresAt: string;
    maxStarts: 1;
  }): Promise<{ requestId: string; requestSha256: string; approverId: string; expiresAt: string }>;
}
export interface SdkTextServiceOptions {
  bus: GitHubSdkTextBus;
  ledger: SdkTextLedger;
  profile: () => ClaudeSdkHostProfile;
  privateRoot: string;
  authority?: SdkTextApprovalAuthority;
  now?: () => Date;
  pathPolicy?: PathPolicy;
}
export interface SdkTextService {
  receive(id: string): Promise<TextJob>;
  approve(id: string): Promise<TextJob>;
  start(id: string, signal?: AbortSignal): Promise<TextJob>;
  reconcile(id: string): Promise<TextJob>;
  cancel(id: string): TextJob;
  get(id: string): TextJob | null;
  beginShutdown(): void;
  close(): Promise<void>;
}
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
async function boundedAuthority<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("sdk_text_authority_timeout")), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function body<T>(raw: string): T {
  return parseStrictJsonBytes(Buffer.from(raw, "base64")) as T;
}
function compose(
  options: SdkTextServiceOptions,
  adapter: SdkTextAdapter,
  probe: (p: ClaudeSdkHostProfile) => Promise<ClaudeSdkProbeObservation>,
): SdkTextService {
  const { bus, ledger, privateRoot } = options,
    now = options.now ?? (() => new Date()),
    policy = options.pathPolicy ?? {},
    rootPin: OwnedRootIdentity = rootIdentity(privateRoot, policy);
  const active = new Map<string, SdkTextRun>();
  const pending = new Set<Promise<unknown>>();
  function track<T>(fn: () => Promise<T>): Promise<T> {
    const operation = Promise.resolve().then(fn);
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  }
  async function claim(job: TextJob) {
    const remote = await bus.readStage(job.requestId, "claim");
    if (
      !remote ||
      (
        parseStrictJsonBytes(Buffer.from(remote.packet.bodyBase64, "base64")) as {
          claimantId?: unknown;
        }
      ).claimantId !== job.claimantId
    )
      throw new Error("sdk_text_claim_owned_elsewhere");
  }
  let closing = false;
  const profile = () => cloneClaudeSdkHostProfile(options.profile());
  const required = (id: string) => {
    const job = ledger.get(id);
    if (!job) throw new Error("sdk_text_job_missing");
    return job;
  };
  const directory = (id: string, attemptId: string) => `sdk-text-evidence/${id}/${attemptId}`;
  const check = (job: TextJob) => {
    const r = parseTextRequest(Buffer.from(job.rawRequestBase64, "base64")),
      p = profile();
    if (
      r.recipientId !== p.recipientId ||
      bus.bus.codec.signer.actorId !== p.recipientId ||
      r.policySha256 !== p.policySha256 ||
      r.sdkProfileSha256 !== sdkProfileDigest(p)
    )
      throw new Error("sdk_text_host_scope_denied");
    return p;
  };
  async function publish(job: TextJob) {
    if (job.resultBase64)
      await bus.publish(job.requestId, "result", Buffer.from(job.resultBase64, "base64"));
    return job;
  }
  function recordedProfile(job: TextJob, intent: TextIntent): ClaudeSdkHostProfile {
    const dir = `sdk-text-launch/${job.requestId}/${intent.attemptId}`;
    const profileRaw = readOwnedFile(
      archivePath(privateRoot, `${dir}/profile.json`),
      16384,
      policy,
    );
    const probeRaw = readOwnedFile(archivePath(privateRoot, `${dir}/probe.json`), 16384, policy);
    const input = readOwnedFile(archivePath(privateRoot, `${dir}/input.txt`), 16384, policy);
    const p = cloneClaudeSdkHostProfile(
      parseStrictJsonBytes(profileRaw) as unknown as ClaudeSdkHostProfile,
    );
    const plan = prepareSdkTextPlan(
      p,
      Buffer.from(job.rawRequestBase64, "base64"),
      Buffer.from(job.markdownBase64, "base64"),
      Buffer.from(job.grantBase64 ?? "", "base64"),
      intent.attemptId,
      intent.deadlineAt,
    );
    if (
      plan.sdkOptionsSha256 !== intent.sdkOptionsSha256 ||
      sha256Bytes(probeRaw) !== intent.probeEvidenceSha256 ||
      !Buffer.from(plan.input).equals(input)
    )
      throw new Error("sdk_text_launch_evidence_invalid");
    verifyImmutableFiles(
      privateRoot,
      dir,
      [
        { relativePath: "profile.json", bytes: profileRaw },
        { relativePath: "probe.json", bytes: probeRaw },
        { relativePath: "input.txt", bytes: input },
      ],
      rootPin,
      policy,
    );
    return p;
  }
  function recover(job: TextJob): TextJob {
    assertRootIdentity(privateRoot, rootPin, policy);
    if (job.resultBase64 || !job.intentBase64 || job.cancelledAt) return job;
    const intent = body<TextIntent>(job.intentBase64),
      dir = directory(job.requestId, intent.attemptId),
      finishPath = archivePath(privateRoot, `${dir}/finish.json`);
    if (!existsSync(finishPath)) return job;
    const source = readOwnedFile(
        archivePath(privateRoot, `${dir}/messages.ndjson`),
        262144,
        policy,
      ),
      rawResult = readOwnedFile(archivePath(privateRoot, `${dir}/result.json`), 65536, policy),
      rawFinish = readOwnedFile(finishPath, 16384, policy);
    const finish = parseStrictJsonBytes(rawFinish) as Record<string, unknown>,
      result = validateTextBody("result", rawResult) as unknown as TextResult;
    if (
      Object.keys(finish).sort().join(",") !==
        "intentSha256,messagesSha256,resultSha256,schema,sdkCloseRequested,sdkIteratorCompleted" ||
      finish.schema !== "sdk-text-private-finish-1" ||
      finish.intentSha256 !== sha256Bytes(Buffer.from(job.intentBase64, "base64")) ||
      finish.messagesSha256 !== sha256Bytes(source) ||
      finish.resultSha256 !== sha256Bytes(rawResult) ||
      finish.sdkCloseRequested !== true ||
      finish.sdkIteratorCompleted !== true
    )
      throw new Error("sdk_text_recovery_binding_invalid");
    const p = recordedProfile(job, intent),
      parser = new ClaudeSdkMessages(
        {
          binding: job,
          attemptId: intent.attemptId,
          binarySha256ObservedBefore: p.binarySha256,
          cliVersion: p.cliVersion,
        },
        () => {},
      );
    const text = new TextDecoder("utf8", { fatal: true }).decode(source);
    if (!text.endsWith("\n")) throw new Error("sdk_text_recovery_truncated");
    for (const line of text.slice(0, -1).split("\n")) parser.feedMessage(JSON.parse(line));
    const recovered = parser.complete({
      sdkIteratorCompleted: true,
      sdkCloseRequested: true,
      cancelled: false,
      finishedAtMs: Date.parse(result.finishedAt),
      deadlineAtMs: Date.parse(intent.deadlineAt),
    });
    if (
      JSON.stringify(recovered.observation) !== JSON.stringify(result.observation) ||
      recovered.text !== result.responseFrame
    )
      throw new Error("sdk_text_recovery_observation_invalid");
    const files = [
      { relativePath: "messages.ndjson", bytes: source },
      { relativePath: "result.json", bytes: rawResult },
      { relativePath: "finish.json", bytes: rawFinish },
    ];
    publishImmutableFiles(privateRoot, dir, files, rootPin, policy);
    verifyImmutableFiles(privateRoot, dir, files, rootPin, policy);
    return ledger.saveResult(job.requestId, rawResult);
  }
  function saveCompleted(job: TextJob, outcome: SdkTextOutcome): TextJob {
    if (
      !job.intentBase64 ||
      outcome.state !== "response_received" ||
      !outcome.observation ||
      !outcome.responseFrame ||
      !outcome.finishedAt
    )
      throw new Error("sdk_text_completion_missing");
    const current = required(job.requestId);
    if (current.cancelledAt) throw new Error("sdk_text_cancelled");
    const intent = body<TextIntent>(job.intentBase64);
    const result: TextResult = {
      schema: "sdk-text-result-1",
      requestId: job.requestId,
      requestSha256: job.requestSha256,
      requesterId: job.requesterId,
      recipientId: job.recipientId,
      attemptId: intent.attemptId,
      fence: 1,
      intentSha256: sha256Bytes(Buffer.from(job.intentBase64, "base64")),
      status: "response_received",
      localExecution: false,
      osConfinementVerified: false,
      syntheticInput: true,
      liveProviderCallObserved: outcome.liveProviderCallObserved,
      responseFrame: outcome.responseFrame,
      observation: outcome.observation,
      finishedAt: outcome.finishedAt,
    };
    const rawResult = bytes(result);
    validateTextBody("result", rawResult);
    const finish = bytes({
      schema: "sdk-text-private-finish-1",
      intentSha256: result.intentSha256,
      messagesSha256: sha256Bytes(outcome.privateMessages),
      resultSha256: sha256Bytes(rawResult),
      sdkIteratorCompleted: true,
      sdkCloseRequested: true,
    });
    const files = [
      { relativePath: "messages.ndjson", bytes: outcome.privateMessages },
      { relativePath: "result.json", bytes: rawResult },
      { relativePath: "finish.json", bytes: finish },
    ];
    publishImmutableFiles(
      privateRoot,
      directory(job.requestId, intent.attemptId),
      files,
      rootPin,
      policy,
    );
    verifyImmutableFiles(
      privateRoot,
      directory(job.requestId, intent.attemptId),
      files,
      rootPin,
      policy,
    );
    return recover(current);
  }
  const service: SdkTextService = {
    get: (id) => ledger.get(id),
    async receive(id) {
      if (closing) throw new Error("sdk_text_stopping");
      const issued = await bus.read(id),
        p = profile();
      if (
        issued.request.recipientId !== p.recipientId ||
        issued.request.sdkProfileSha256 !== sdkProfileDigest(p) ||
        issued.request.policySha256 !== p.policySha256 ||
        Date.parse(issued.request.expiresAt) <= now().getTime()
      )
        throw new Error("sdk_text_host_scope_denied");
      if (closing) throw new Error("sdk_text_stopping");
      // This ledger's durable claimant is the sole remote claim owner. All remote failures remain no-dispatch.
      const job = ledger.receive(issued);
      check(job);
      await bus.publish(
        id,
        "claim",
        bytes({
          schema: "sdk-text-claim-1",
          requestId: id,
          requestSha256: job.requestSha256,
          requesterId: job.requesterId,
          recipientId: job.recipientId,
          claimantId: job.claimantId,
        }),
      );
      return job;
    },
    async approve(id) {
      if (closing || !options.authority) throw new Error("sdk_text_authority_unavailable");
      const job = required(id),
        p = check(job);
      await claim(job);
      if (job.grantBase64) {
        await bus.publish(id, "approval", Buffer.from(job.grantBase64, "base64"));
        return job;
      }
      const request = parseTextRequest(Buffer.from(job.rawRequestBase64, "base64")),
        issuedAt = now(),
        expiresAt = new Date(
          Math.min(issuedAt.getTime() + 60000, Date.parse(request.expiresAt)),
        ).toISOString();
      const approved = await boundedAuthority(
        options.authority.approve({
          requestId: id,
          requestSha256: job.requestSha256,
          profileSha256: request.sdkProfileSha256,
          approverId: p.approverId,
          expiresAt,
          maxStarts: 1,
        }),
      );
      if (
        closing ||
        approved.requestId !== id ||
        approved.requestSha256 !== job.requestSha256 ||
        approved.approverId !== p.approverId ||
        approved.expiresAt !== expiresAt ||
        sdkProfileDigest(check(required(id))) !== sdkProfileDigest(p)
      )
        throw new Error("sdk_text_approval_scope_changed");
      const grant: TextApproval = {
        schema: "sdk-text-approval-1",
        requestId: id,
        requestSha256: job.requestSha256,
        requesterId: job.requesterId,
        recipientId: job.recipientId,
        grantId: randomUUID(),
        nonce: randomUUID(),
        issuedPacketSha256: job.issuedPacketSha256,
        taskFileSha256: request.taskFileSha256,
        policySha256: p.policySha256,
        sdkProfileSha256: request.sdkProfileSha256,
        executionProfile: "official-sdk-managed",
        approverId: p.approverId,
        issuedAt: issuedAt.toISOString(),
        expiresAt,
        maxStarts: 1,
      };
      const saved = ledger.approve(id, bytes(grant), now());
      await bus.publish(id, "approval", Buffer.from(saved.grantBase64 ?? "", "base64"));
      return saved;
    },
    async start(id, signal) {
      const job = required(id);
      if (job.intentBase64) return service.reconcile(id);
      if (closing || signal?.aborted) throw new Error("sdk_text_stopping");
      const p = check(job);
      if (!job.grantBase64) throw new Error("sdk_text_approval_required");
      await claim(job);
      const observed = await probe(p);
      if (
        closing ||
        signal?.aborted ||
        sdkProfileDigest(check(required(id))) !== sdkProfileDigest(p) ||
        observed.profileRevision !== p.revision ||
        observed.approvedAuthContextId !== p.approvedAuthContextId ||
        observed.providerRouteId !== p.providerRouteId ||
        observed.binarySha256 !== p.binarySha256 ||
        now().getTime() - Date.parse(observed.observedAt) > 15000 ||
        Date.parse(observed.observedAt) > now().getTime()
      )
        throw new Error("sdk_text_probe_stale_or_changed");
      const request = parseTextRequest(Buffer.from(job.rawRequestBase64, "base64")),
        time = now(),
        attemptId = randomUUID(),
        deadlineAt = new Date(
          Math.min(time.getTime() + 60000, Date.parse(request.expiresAt)),
        ).toISOString();
      const plan = prepareSdkTextPlan(
        p,
        Buffer.from(job.rawRequestBase64, "base64"),
        Buffer.from(job.markdownBase64, "base64"),
        Buffer.from(job.grantBase64, "base64"),
        attemptId,
        deadlineAt,
      );
      const intent = ledger.reserveStart(
        id,
        {
          probeEvidenceSha256: sha256Bytes(bytes(observed)),
          sdkOptionsSha256: plan.sdkOptionsSha256,
          attemptId,
        },
        time,
        signal,
      );
      if (!intent.created) return service.reconcile(id);
      const launchFiles = [
        { relativePath: "profile.json", bytes: bytes(p) },
        { relativePath: "probe.json", bytes: bytes(observed) },
        { relativePath: "input.txt", bytes: Buffer.from(plan.input) },
      ];
      publishImmutableFiles(
        privateRoot,
        `sdk-text-launch/${id}/${attemptId}`,
        launchFiles,
        rootPin,
        policy,
      );
      verifyImmutableFiles(
        privateRoot,
        `sdk-text-launch/${id}/${attemptId}`,
        launchFiles,
        rootPin,
        policy,
      );

      if (
        closing ||
        signal?.aborted ||
        now().getTime() - Date.parse(observed.observedAt) > 15000 ||
        required(id).cancelledAt ||
        sdkProfileDigest(check(required(id))) !== sdkProfileDigest(p)
      ) {
        await bus.publish(id, "intent", Buffer.from(intent.job.intentBase64 ?? "", "base64"));
        return required(id);
      }
      const run = adapter.begin(plan, signal);
      active.set(id, run);
      // A separate CLI process can cancel through the durable ledger; only this owner controls its query.
      const cancellationPoll = setInterval(() => {
        try {
          const current = ledger.get(id);
          if (!current || current.cancelledAt) run.cancel();
        } catch {
          run.cancel();
        }
      }, 200);
      void run.settled.then(() => {
        clearInterval(cancellationPoll);
        if (active.get(id) === run) active.delete(id);
      });
      const outcome = await run.outcome;
      // Remote outbox latency must not consume or extend the fresh local launch authorization.
      // The durable local intent preceded the sole query; publish it before any terminal packet.
      if (outcome.state !== "response_received") {
        const observation = bytes({
          schema: "sdk-text-attempt-observation-1",
          requestId: id,
          intentSha256: sha256Bytes(Buffer.from(intent.job.intentBase64 ?? "", "base64")),
          queryInvocations: outcome.queryInvocations,
          state: outcome.state,
          failureCode: outcome.failureCode,
          cleanup: outcome.cleanup,
          osProcessExit: "unobserved",
        });
        publishImmutableFiles(
          privateRoot,
          `sdk-text-observations/${id}/${intent.job.revision}`,
          [{ relativePath: "observation.json", bytes: observation }],
          rootPin,
          policy,
        );
        await bus.publish(id, "intent", Buffer.from(intent.job.intentBase64 ?? "", "base64"));
        return required(id);
      }
      const saved = saveCompleted(intent.job, outcome);
      await bus.publish(id, "intent", Buffer.from(intent.job.intentBase64 ?? "", "base64"));
      return publish(saved);
    },
    async reconcile(id) {
      const job = recover(required(id));
      if (job.intentBase64)
        await bus.publish(id, "intent", Buffer.from(job.intentBase64, "base64"));
      return publish(job);
    },
    cancel(id) {
      const value = ledger.cancel(id, now());
      active.get(id)?.cancel();
      return value;
    },
    beginShutdown() {
      closing = true;
      for (const run of active.values()) run.cancel();
    },
    async close() {
      service.beginShutdown();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(
            [...active.values()]
              .map((r) => r.settled)
              .concat(
                [...pending].map((p) =>
                  p.then(
                    () => undefined,
                    () => undefined,
                  ),
                ),
              ),
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("sdk_text_drain_pending")), 6000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
  return {
    ...service,
    receive: (id) => track(() => service.receive(id)),
    approve: (id) => track(() => service.approve(id)),
    start: (id, signal) => track(() => service.start(id, signal)),
    reconcile: (id) => track(() => service.reconcile(id)),
  };
}
export async function createSdkTextService(
  options: SdkTextServiceOptions,
): Promise<SdkTextService> {
  return compose(options, await loadOfficialSdkTextAdapter(), probeClaudeSdkHost);
}
export function fakeSdkTextService(
  options: SdkTextServiceOptions,
  adapter: SdkTextAdapter,
  probe: (profile: ClaudeSdkHostProfile) => Promise<ClaudeSdkProbeObservation>,
): SdkTextService {
  if (adapter.source !== "fake-sdk") throw new Error("sdk_text_fake_port_required");
  return compose(options, adapter, probe);
}
