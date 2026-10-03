import { describe, expect, it } from "vitest";
import {
  createHostedPromptFormatLookup,
  createHostedPromptReceipt,
  encodeBrowserDeliveryPolicyV2,
  HostedPromptPolicyRegistry,
  hostedPromptPolicyDetails,
  parseBrowserDeliveryPolicyV2,
  parseHostedPromptReceipt,
  registerHostedPromptPolicy,
  validateHostedPromptTask,
} from "../../src/adapters/hosted-prompt-policy.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { encodeTaskBrief } from "../../src/prompt-rendering/brief.js";
import {
  revokeHostedRenderer,
  type VerifiedHostedRenderer,
} from "../../src/prompt-rendering/hosted-registry.js";
import { hostedPromptFixture } from "../helpers/hosted-prompt-fixture.js";

describe("canonical recipient-owned hosted prompt policy and receipt", () => {
  it("round-trips canonical V2 policy and binds its original bytes to the opaque renderer", () => {
    const f = hostedPromptFixture();
    expect(parseBrowserDeliveryPolicyV2(f.policyRaw)).toEqual(f.policy);
    expect(hostedPromptPolicyDetails(f.registration).policySha256).toBe(sha256Bytes(f.policyRaw));
    expect(() =>
      registerHostedPromptPolicy(f.policyRaw, {
        kind: "verified-hosted-renderer-1",
      } as VerifiedHostedRenderer),
    ).toThrow();
    const edited = structuredClone(f.policy);
    edited.delivery.maxStarts = 1;
    expect(() =>
      registerHostedPromptPolicy(encodeBrowserDeliveryPolicyV2(edited), f.renderer),
    ).toThrow("registration_mismatch");
  });
  it.each(["extra", "duplicate", "reordered", "missing-lf", "bom", "array-enum"])(
    "rejects %s policy bytes",
    (mode) => {
      const f = hostedPromptFixture();
      let s = Buffer.from(f.policyRaw).toString();
      if (mode === "extra") s = s.replace('{"schema"', '{"unexpected":true,"schema"');
      if (mode === "duplicate")
        s = s.replace('{"schema"', '{"schema":"bridge-browser-delivery-policy-2","schema"');
      if (mode === "reordered") {
        const { delivery, schema, prompt } = f.policy;
        s = `${JSON.stringify({ delivery, schema, prompt })}\n`;
      }
      if (mode === "missing-lf") s = s.slice(0, -1);
      if (mode === "bom") s = `\ufeff${s}`;
      if (mode === "array-enum") s = s.replace('"contextMode":"none"', '"contextMode":["none"]');
      expect(() => parseBrowserDeliveryPolicyV2(Buffer.from(s))).toThrow();
    },
  );
  it.each(["current", "latest", "unknown"])("rejects unregistered model %s", (model) => {
    const f = hostedPromptFixture();
    const v = structuredClone(f.policy);
    Object.assign(v.prompt, { modelId: model });
    Object.assign(v.delivery, { model });
    expect(() => encodeBrowserDeliveryPolicyV2(v)).toThrow();
  });
  it("rejects nonempty context, substituted task bytes and different policy before rendering", () => {
    const f = hostedPromptFixture();
    expect(() =>
      validateHostedPromptTask(f.registration, f.rawTaskSpec, Buffer.from("other")),
    ).toThrow();
    const task = { ...f.task, policy_snapshot_sha256: "b".repeat(64) };
    expect(() =>
      validateHostedPromptTask(f.registration, Buffer.from(JSON.stringify(task)), f.taskFileBytes),
    ).toThrow();
    const bytes = encodeTaskBrief({
      taskKind: "answer",
      objective: "x",
      constraints: [],
      deliverables: [],
      acceptance: [],
      context: [
        {
          id: "s",
          revision: "r",
          sha256: sha256Bytes(Buffer.from("x")),
          sizeBytes: 1,
          mediaType: "text/plain",
          trust: "untrusted",
          placement: "variable",
        },
      ],
    });
    expect(() =>
      validateHostedPromptTask(
        f.registration,
        Buffer.from(JSON.stringify({ ...f.task, task_file_hash: sha256Bytes(bytes) })),
        bytes,
      ),
    ).toThrow("context_denied");
  });
  it.each(["gpt-5.6-sol", "gpt-5.5"] as const)(
    "creates exact receipt for %s without a hash cycle",
    (model) => {
      const f = hostedPromptFixture(model);
      const r = createHostedPromptReceipt(
        f.registration,
        f.rawTaskSpec,
        f.taskFileBytes,
        f.frame,
        f.outputContractRaw,
      );
      expect(parseHostedPromptReceipt(r.receiptRaw)).toEqual(r.receipt);
      expect(r.receipt.promptSha256).toBe(sha256Bytes(r.promptBytes));
      expect(r.receipt.taskSpecSha256).toBe(sha256Bytes(f.rawTaskSpec));
      expect(Buffer.from(r.promptBytes).toString()).not.toContain(r.receipt.promptSha256);
      expect(r.receipt.session).toBeNull();
      expect(r.receipt.bootstrap).toBeNull();
      expect(
        createHostedPromptReceipt(
          f.registration,
          f.rawTaskSpec,
          f.taskFileBytes,
          f.frame,
          f.outputContractRaw,
        ),
      ).toEqual(r);
    },
  );
  it.each(["attempt", "contract", "raw-spec"])(
    "rejects or distinguishes changed %s binding",
    (part) => {
      const f = hostedPromptFixture();
      if (part === "attempt") {
        expect(() =>
          createHostedPromptReceipt(
            f.registration,
            f.rawTaskSpec,
            f.taskFileBytes,
            { ...f.frame, attemptId: "bad" },
            f.outputContractRaw,
          ),
        ).toThrow();
        return;
      }
      if (part === "contract") {
        expect(() =>
          createHostedPromptReceipt(
            f.registration,
            f.rawTaskSpec,
            f.taskFileBytes,
            f.frame,
            Buffer.from("{}"),
          ),
        ).toThrow();
        return;
      }
      expect(() =>
        createHostedPromptReceipt(
          f.registration,
          Buffer.concat([f.rawTaskSpec, Buffer.from("\n")]),
          f.taskFileBytes,
          f.frame,
          f.outputContractRaw,
        ),
      ).toThrow();
    },
  );
  it("rejects malformed, extra-key and noncanonical receipt bytes", () => {
    const f = hostedPromptFixture(),
      r = createHostedPromptReceipt(
        f.registration,
        f.rawTaskSpec,
        f.taskFileBytes,
        f.frame,
        f.outputContractRaw,
      );
    for (const raw of [
      Buffer.from("{}"),
      Buffer.from(`${r.receiptRaw.toString()}\n`),
      Buffer.from(`${JSON.stringify({ ...r.receipt, promptSizeBytes: -1 })}\n`),
      Buffer.from(`${JSON.stringify({ ...r.receipt, verified: true })}\n`),
    ])
      expect(() => parseHostedPromptReceipt(raw)).toThrow();
  });
  it("preserves the existing browser 20000-character limit before admission", () => {
    const f = hostedPromptFixture();
    const bytes = encodeTaskBrief({
      taskKind: "answer",
      objective: "x".repeat(21000),
      constraints: [],
      deliverables: [],
      acceptance: [],
      context: [],
    });
    const task = { ...f.task, task_file_hash: sha256Bytes(bytes) },
      raw = Buffer.from(JSON.stringify(task));
    const contract = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(f.outputContractRaw).toString()),
        taskFileHash: task.task_file_hash,
        taskSpecHash: sha256Bytes(raw),
      }),
    );
    expect(() =>
      createHostedPromptReceipt(
        f.registration,
        raw,
        bytes,
        { ...f.frame, taskSpecHash: sha256Bytes(raw) },
        contract,
      ),
    ).toThrow("composer_limit");
  });
  it("accepts exactly20000 prompt characters and rejects the next character", () => {
    const f = hostedPromptFixture();
    const render = (size: number) => {
      const bytes = encodeTaskBrief({
        taskKind: "answer",
        objective: "x".repeat(size),
        constraints: [],
        deliverables: [],
        acceptance: [],
        context: [],
      });
      const task = { ...f.task, task_file_hash: sha256Bytes(bytes) },
        raw = Buffer.from(JSON.stringify(task));
      const contract = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(f.outputContractRaw).toString()),
          taskFileHash: task.task_file_hash,
          taskSpecHash: sha256Bytes(raw),
        }),
      );
      return createHostedPromptReceipt(
        f.registration,
        raw,
        bytes,
        { ...f.frame, taskSpecHash: sha256Bytes(raw) },
        contract,
      );
    };
    const overhead = Buffer.from(render(1).promptBytes).toString().length - 1;
    expect(Buffer.from(render(20000 - overhead).promptBytes).toString().length).toBe(20000);
    expect(() => render(20001 - overhead)).toThrow("hosted_prompt_composer_limit");
  });
  it("uses positive legacy registration and denies unknown/revoked historical renderer handles", () => {
    const f = hostedPromptFixture();
    const registry = new HostedPromptPolicyRegistry();
    registry.add(f.registration);
    const destination = {
      destinationId: "browser",
      route: "ordinary_chat_browser" as const,
      recipientActorId: "recipient",
      providerId: "chatgpt-browser",
      modelIds: [f.task.requested_model],
      capabilities: {},
      unavailableReason: null,
      policyHash: f.policySnapshotSha256,
    };
    expect(createHostedPromptFormatLookup(registry)(destination, f.task.requested_model)).toBe(
      f.renderer,
    );
    expect(() =>
      createHostedPromptFormatLookup(registry)(
        { ...destination, policyHash: "b".repeat(64) },
        f.task.requested_model,
      ),
    ).toThrow("unavailable");
    expect(
      createHostedPromptFormatLookup(registry, ["b".repeat(64)])(
        { ...destination, policyHash: "b".repeat(64) },
        f.task.requested_model,
      ),
    ).toBeNull();
    revokeHostedRenderer(f.renderer);
    expect(() => registry.get(f.policySnapshotSha256)).toThrow();
  });
});
