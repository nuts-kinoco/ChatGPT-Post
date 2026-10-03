import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserDeliveryService, type BrowserRun } from "../../src/adapters/browser-delivery.js";
import type { GitHubTaskBus, IssuedMessage } from "../../src/adapters/github-transport.js";
import {
  ExactHostedSourceResolver,
  type HostedTurnSnapshot,
} from "../../src/archive/hosted-source.js";
import { RouteArtifactArchive } from "../../src/archive/route-store.js";
import { buildRecoveredResult } from "../../src/cli/collect.js";
import { loadConfig } from "../../src/cli/config.js";
import type {
  HostedExpectedOutputPolicy,
  OutputContractV1,
} from "../../src/contracts/output-contract.js";
import { encodeResponseFrame } from "../../src/contracts/response-frame.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { ProjectRegistry } from "../../src/state/project-registry.js";
import { adapterTask, adapterTaskBytes } from "../helpers/adapter-fixture.js";

const dirs: string[] = [],
  closers: (() => void)[] = [];
function dir() {
  const p = mkdtempSync(join(tmpdir(), "hosted-archive-integration-"));
  dirs.push(p);
  return p;
}
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
});
async function setup(archiveEnabled = true) {
  const state = dir(),
    root = dir(),
    registry = new ProjectRegistry(join(state, "registry.db"));
  closers.push(() => registry.close());
  const projectId = randomUUID();
  registry.configure(
    {
      schema: "bridge-project-registry-1",
      revision: 1,
      defaultOutputRoot: root,
      projects: [
        {
          projectId,
          repoId: "fixture-repo",
          storageSlug: "fixture",
          displayName: "fixture",
          githubDestination: {
            repositoryFullName: "owner/bus",
            branch: "main",
            namespace: "bridge-v2",
          },
          outputRootOverride: null,
        },
      ],
    },
    0,
  );
  const archive = new RouteArtifactArchive({ stateDirectory: state, registry });
  closers.push(() => archive.close());
  let contractRaw: Uint8Array = new Uint8Array();
  const expectedOutputPolicy: HostedExpectedOutputPolicy = {
    route: "hosted_delivery",
    requesterActorId: "requester",
    recipientActorId: "recipient",
    projectId,
    repoId: "fixture-repo",
    storageSlug: "fixture",
    destination: {
      repositoryFullName: "owner/bus",
      branch: "main",
      namespace: "bridge-v2",
      conversationId: "fixture",
    },
    mode: "text_only",
    requiredOutputs: [],
    allowAdditionalArtifacts: false,
    maxArtifacts: 0,
    maxTotalBytes: 0,
  };
  let starts = 0,
    turns: HostedTurnSnapshot[] = [],
    publicationCount = 0;
  const now = new Date("2026-10-03T05:00:00.000Z");
  const bus = {
    codec: { signer: { actorId: "recipient" } },
    git: {
      snapshot: async () => ({ commit: "a".repeat(40), tree: "b".repeat(40), files: new Map() }),
    },
    publishHosted: async () => {
      publicationCount++;
      return "a".repeat(40);
    },
    readHosted: async () => null,
  } as unknown as GitHubTaskBus;
  const resolver = new ExactHostedSourceResolver({
    read: async () => ({ state: "available", conversationId: "fixture", turns }),
  });
  const run: BrowserRun = async (path) => {
    starts++;
    const request = JSON.parse(await readFile(path, "utf8")),
      identity = JSON.parse(await readFile(join(dirname(path), "framing.json"), "utf8"));
    const prompt = await readFile(join(dirname(path), "prompt.md"), "utf8");
    const response = encodeResponseFrame(
      `BRIDGE ARTIFACT DECLARATION ${JSON.stringify({ schema: "artifact-declaration-1", ...identity, outputContractSha256: sha256Bytes(contractRaw), outputs: [] })}\nolder exact answer`,
      identity,
    );
    turns = [
      { messageId: "user-old", role: "user", text: prompt, markdown: prompt, artifacts: [] },
      {
        messageId: "assistant-old",
        role: "assistant",
        text: response,
        markdown: response,
        artifacts: [],
        artifactEnumerationKnown: false,
        artifactObservationChecked: true,
        artifactReaderVersion: "trusted-snapshot-1",
      },
      {
        messageId: "user-new",
        role: "user",
        text: "unrelated later",
        markdown: "unrelated later",
        artifacts: [],
      },
      {
        messageId: "assistant-new",
        role: "assistant",
        text: "newest unrelated answer",
        markdown: "newest unrelated answer",
        artifacts: [],
        artifactEnumerationKnown: false,
        artifactObservationChecked: true,
        artifactReaderVersion: "trusted-snapshot-1",
      },
    ];
    const failed = buildRecoveredResult(
      {
        requestId: request.requestId,
        conversationUrl: request.conversationUrl,
        submittedAt: now.toISOString(),
      },
      { markdown: "", method: "dom", quality: "degraded", modelSlug: null },
      join(dirname(path), "response.md"),
      "test",
      now,
    );
    failed.status = "failed";
    failed.responseFile = null;
    failed.submitted = "unknown";
    failed.extractionMethod = null;
    failed.extractionQuality = null;
    delete failed.recoveredBy;
    delete failed.recoveredFromSubmittedAt;
    failed.error = {
      code: "SUBMIT_STATE_UNKNOWN",
      message: "synthetic interruption",
      retryable: false,
      phase: "PROMPT_SUBMITTING",
      cause: "fixture",
    };
    return failed;
  };
  const service = new BrowserDeliveryService(
    bus,
    loadConfig({ CHATGPT_BRIDGE_RUNTIME_DIR: state }),
    {
      recipientId: "recipient",
      requesterIds: ["requester"],
      conversationUrl: "https://chatgpt.com/c/fixture",
      model: "current",
      preset: "current",
      maxStarts: 5,
      deadlineAt: "2026-10-03T06:00:00.000Z",
      maxResponseBytes: 100000,
      expectedOutputPolicy,
    },
    run,
    () => now,
    { ...(archiveEnabled ? { archive } : {}), sourceResolver: resolver },
  );
  closers.push(() => service.close());
  const task = Object.assign(adapterTask(), {
    agent: "chatgpt-browser",
    requested_model: "current",
    mode: "read_only",
    allowed_commands: [],
    policy_snapshot_sha256: service.policyHash,
    timeout: { run_seconds: 10, cancel_grace_seconds: 1 },
  });
  const raw = Buffer.from(JSON.stringify(task));
  const contract: OutputContractV1 = {
    ...expectedOutputPolicy,
    requiredOutputs: [],
    schema: "output-contract-1",
    requestId: task.request_id,
    taskSpecHash: sha256Bytes(raw),
    taskFileHash: task.task_file_hash,
    policySnapshotSha256: service.policyHash,
    registryRevision: 1,
    registrySnapshotSha256: registry.snapshotHash(1),
    declarationFormat: "bridge-artifact-declaration-1",
  };
  contractRaw = Buffer.from(JSON.stringify(contract));
  const issued: IssuedMessage & {
    projectRegistration: { projectId: string; registryRevision: number; snapshotSha256: string };
  } = {
    kind: "issued",
    version: "bridge-issued-2",
    outputContractSha256: sha256Bytes(contractRaw),
    fanoutId: null,
    repoId: task.repo,
    projectSlug: "fixture",
    requestId: task.request_id,
    taskSpecHash: sha256Bytes(raw),
    taskFileHash: task.task_file_hash,
    requesterId: "requester",
    recipientId: "recipient",
    route: "ordinary_chat_browser",
    projectRegistration: {
      projectId,
      registryRevision: 1,
      snapshotSha256: registry.snapshotHash(1),
    },
  };
  return {
    service,
    archive,
    registry,
    issued,
    contractRaw,
    raw,
    task,
    starts: () => starts,
    published: () => publicationCount,
    setTurns: (v: HostedTurnSnapshot[]) => {
      turns = v;
    },
    turns: () => turns,
  };
}
describe("hosted same-attempt archive integration; fake browser and transport only", () => {
  it("pins before acceptance and recovers exact older response after unknown without resend", async () => {
    const x = await setup();
    x.service.receive(x.issued, x.raw, adapterTaskBytes, x.contractRaw);
    const pin = x.archive.pin(x.issued.requestId);
    expect(pin.registryRevision).toBe(1);
    expect(x.service.get(x.issued.requestId)?.revision).toBe(1);
    x.service.approve(x.issued.requestId, {
      actorId: "owner",
      taskSpecHash: x.issued.taskSpecHash,
      expiresAt: "2026-10-03T05:10:00.000Z",
      authenticated: true,
    });
    const first = await x.service.start(x.issued.requestId);
    expect(first.state).toBe("unknown");
    expect(first.response).toBeNull();
    expect(first.event).toBeNull();
    expect(x.service.observations(x.issued.requestId)).toHaveLength(1);
    expect(x.published()).toBe(0);
    const recovered = await x.service.reconcile(x.issued.requestId);
    expect(recovered.state).toBe("completed");
    expect(recovered.response?.markdown).toContain("older exact answer");
    expect(recovered.source?.state).toBe("available");
    expect(recovered.response?.result.observedModel).toBeNull();
    expect(recovered.response?.attemptId).toBe(first.attemptId);
    expect(x.starts()).toBe(1);
    expect(x.archive.inspect(x.issued.requestId).state).toBe("complete");
    expect(recovered.revision).toBeGreaterThan(first.revision);
    expect(x.service.list()).toHaveLength(1);
    expect(x.service.recentPage().requestIds).toEqual([x.issued.requestId]);
    expect(x.service.listPage().requestIds).toEqual([x.issued.requestId]);
    expect(() => x.service.recentPage(randomUUID())).toThrow("browser_delivery_cursor_missing");
    expect(x.service.latestObservation(x.issued.requestId)?.result.status).toBe("completed");
  });
  it("unchecked artifact observation blocks terminal publication even when exact response is recovered", async () => {
    const x = await setup();
    x.service.receive(x.issued, x.raw, adapterTaskBytes, x.contractRaw);
    x.service.approve(x.issued.requestId, {
      actorId: "owner",
      taskSpecHash: x.issued.taskSpecHash,
      expiresAt: "2026-10-03T05:10:00.000Z",
      authenticated: true,
    });
    await x.service.start(x.issued.requestId);
    x.setTurns(x.turns().map((t) => ({ ...t, artifactObservationChecked: false })));
    await expect(x.service.reconcile(x.issued.requestId)).rejects.toThrow(
      "archive_hosted_incomplete",
    );
    expect(x.published()).toBe(0);
    expect(x.starts()).toBe(1);
    expect(x.archive.inspect(x.issued.requestId).state).toBe("incomplete");
  });
  it("configured legacy admissions without historical registry binding fail before pin creation", async () => {
    const x = await setup();
    const legacy = { ...x.issued, projectRegistration: null };
    expect(() =>
      x.service.receive(legacy as unknown as IssuedMessage, x.raw, adapterTaskBytes),
    ).toThrow("output_contract_required");
    expect(x.service.get(x.issued.requestId)).toBeNull();
    expect(x.archive.hasPin(x.issued.requestId)).toBe(false);
  });
  it("same-attempt ambiguous prompt/frame matches stay unknown, no latest fallback", async () => {
    const x = await setup();
    x.service.receive(x.issued, x.raw, adapterTaskBytes, x.contractRaw);
    x.service.approve(x.issued.requestId, {
      actorId: "owner",
      taskSpecHash: x.issued.taskSpecHash,
      expiresAt: "2026-10-03T05:10:00.000Z",
      authenticated: true,
    });
    await x.service.start(x.issued.requestId);
    const old = x.turns().slice(0, 2);
    x.setTurns([...old, ...old.map((t) => ({ ...t, messageId: `other-${t.messageId}` }))]);
    const result = await x.service.reconcile(x.issued.requestId);
    expect(result.response).toBeNull();
    expect(result.state).toBe("unknown");
    expect(x.starts()).toBe(1);
    expect(x.published()).toBe(0);
  });
});
