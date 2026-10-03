import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createIssuerSession } from "../../src/adapters/issuer-session.js";
import {
  assertCapabilityFresh,
  parsePreparedComposer,
  validateIssuerPreparation,
} from "../../src/contracts/issuer.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import { issuerFixture } from "../helpers/issuer-fixture.js";

const bytes = (result: { signedPreparationBase64: string }) =>
  Buffer.from(result.signedPreparationBase64, "base64");
describe("scoped registered issuer", () => {
  it("signs recipient discovery without issue, recipe, or execution", async () => {
    const f = issuerFixture();
    const c = (await f.facade.catalogue()) as { capabilities: { signedBase64: string }[] };
    expect(c.capabilities).toHaveLength(1);
    const decoded = f.bus.codec.decode(
      Buffer.from(c.capabilities[0]?.signedBase64 ?? "", "base64"),
    );
    expect(decoded.actorId).toBe("recipient");
    expect(decoded.message.kind).toBe("issuer_capability");
    expect(f.git.appends).toBe(0);
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("prepares exact caller-stable UUIDs via the shared recipe and issues the signed immutable bytes", async () => {
    const f = issuerFixture(),
      input = f.input(),
      prepared = await f.facade.prepare(input);
    expect(prepared.prepared.preview.previewId).toBe(input.identities.previewId);
    expect(prepared.prepared.preview.children[0]?.requestId).toBe(input.identities.requestIds[0]);
    expect(f.git.appends).toBe(0);
    await f.facade.issue(bytes(prepared));
    expect(f.git.appends).toBe(1);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    const child = prepared.prepared.preview.children[0];
    if (!child) throw new Error("fixture");
    const issued = await f.bus.readIssued(
      await f.git.snapshot(),
      f.bus.path("inbox", child.requestId, "issued.json"),
    );
    expect(issued.issued.taskSpecHash).toBe(child.taskSpecHash);
    expect(Buffer.from(issued.taskBytes).toString()).toBe(child.taskMarkdown);
    expect(await f.facade.result(bytes(prepared), child.requestId)).toMatchObject({
      state: "pending",
      reexecute: false,
    });
  });
  it("rejects mutated receipt bytes and another requester before reading any result", async () => {
    const f = issuerFixture(),
      p = await f.facade.prepare(f.input());
    const raw = bytes(p),
      doc = JSON.parse(raw.toString());
    doc.actorId = "other";
    await expect(
      f.facade.result(
        Buffer.from(JSON.stringify(doc)),
        p.prepared.preview.children[0]?.requestId ?? "",
      ),
    ).rejects.toThrow();
    expect(f.git.appends).toBe(0);
  });
  it("denies session/project/destination scope without mutation", async () => {
    const f = issuerFixture();
    f.session.allowedProjectIds = [randomUUID()];
    await expect(f.facade.prepare(f.input())).rejects.toThrow("issuer_scope_denied");
    expect(f.git.appends).toBe(0);
  });
  it("preserves observation time when signing cached records and rejects future/expired data", async () => {
    const f = issuerFixture();
    const first = await f.facade.catalogue();
    f.advance(1000);
    expect(await f.facade.catalogue()).toEqual(first);
    f.capability.observedAt = new Date(f.now().getTime() + 1000).toISOString();
    await expect(f.facade.catalogue()).rejects.toThrow("issuer_capability_stale");
    f.advance(60000);
    await expect(f.facade.catalogue()).rejects.toThrow("issuer_capability_stale");
  });
  it("rechecks expiry/policy/capability after asynchronous signing before append", async () => {
    for (const change of ["expiry", "policy", "capability"] as const) {
      const f = issuerFixture(),
        p = await f.facade.prepare(f.input());
      f.signerHooks.requester = async () => {
        if (change === "expiry") f.advance(3600001);
        else if (change === "policy") f.destination.policyHash = "a".repeat(64);
        else f.capability.actions.issue = { available: false, reason: "revoked" };
      };
      await expect(f.facade.issue(bytes(p))).rejects.toThrow();
      expect(f.git.appends).toBe(0);
    }
  });
  it("does not accept a requester signature as recipient capability", async () => {
    const f = issuerFixture();
    await expect(
      f.bus.codec.encode({ kind: "issuer_capability", capability: f.capability }),
    ).rejects.toThrow("transport_actor_denied");
  });
  it("keeps historical ownership readable with expired discovery and a renewed same-requester session", async () => {
    const f = issuerFixture(),
      p = await f.facade.prepare(f.input());
    await f.facade.issue(bytes(p));
    f.advance(60000);
    f.session.sessionId = randomUUID();
    const id = p.prepared.preview.children[0]?.requestId ?? "";
    expect(await f.facade.result(bytes(p), id)).toMatchObject({ state: "pending" });
    await expect(f.facade.issue(bytes(p))).rejects.toThrow("issuer_preparation_expired");
  });
  it("does not regenerate IDs or a recipe after a lost append response", async () => {
    const f = issuerFixture(),
      p = await f.facade.prepare(f.input());
    f.git.loseReply = true;
    await expect(f.facade.issue(bytes(p))).rejects.toThrow("fixture_lost_reply");
    f.advance(60000);
    expect(
      await f.facade.result(bytes(p), p.prepared.preview.children[0]?.requestId ?? ""),
    ).toMatchObject({ state: "pending" });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.git.appends).toBe(1);
  });
  it("fails closed on malformed preparation metadata, base64 or stale times", async () => {
    const f = issuerFixture(),
      p = await f.facade.prepare(f.input());
    const d = f.bus.codec.decode(bytes(p));
    if (d.message.kind !== "issuer_preparation") throw new Error("fixture");
    const preparation = d.message.preparation;
    expect(() =>
      validateIssuerPreparation({ ...preparation, preparedSha256: "a".repeat(64) }),
    ).toThrow();
    expect(() => parsePreparedComposer(Buffer.from("{}"))).toThrow();
    expect(() => assertCapabilityFresh(f.capability, f.now(), 60001)).toThrow();
    expect(sha256Bytes(bytes(p))).toBe(p.preparationSha256);
  });
  it("fails closed when current capability source or registered provider differs", async () => {
    const f = issuerFixture();
    f.capability.providerId = "other-provider";
    await expect(f.facade.prepare(f.input())).rejects.toThrow("issuer_capability_binding_mismatch");
    expect(f.git.appends).toBe(0);
  });
  it("does not return data outside the authenticated preparation even for a valid UUID", async () => {
    const f = issuerFixture(),
      p = await f.facade.prepare(f.input());
    const snapshot = vi.spyOn(f.git, "snapshot");
    await expect(f.facade.result(bytes(p), randomUUID())).rejects.toThrow(
      "issuer_request_scope_denied",
    );
    expect(snapshot).not.toHaveBeenCalled();
  });
  it("rejects incomplete host configuration instead of starting another channel", () => {
    const f = issuerFixture();
    expect(() => createIssuerSession({ ...f.options, maxCapabilityAgeMs: 60001 })).toThrow(
      "issuer_configuration_invalid",
    );
  });
});

describe("published preparation is the historical destination binding", () => {
  it("cannot relabel an identical issued task using another valid signed preparation", async () => {
    const f = issuerFixture(),
      firstInput = f.input(),
      one = await f.facade.prepare(firstInput);
    await f.facade.issue(bytes(one));
    const second = { ...structuredClone(f.destination), destinationId: "destination-b" };
    f.destinations.push(second);
    f.session.allowedDestinationIds.push(second.destinationId);
    const cap = { ...structuredClone(f.capability), destinationId: second.destinationId };
    f.capabilities.push({ codec: f.recipient.codec, current: () => cap });
    // A new facade observes the explicitly extended host registration; it does not change old receipt ownership.
    const facade = createIssuerSession(f.options);
    const otherInput = {
      ...firstInput,
      identities: { ...firstInput.identities, previewId: randomUUID() },
      request: {
        ...firstInput.request,
        destinations: [{ destinationId: second.destinationId, modelId: second.modelIds[0] }],
      },
    };
    const two = await facade.prepare(otherInput);
    expect(two.prepared.preview.children[0]?.taskSpecHash).toBe(
      one.prepared.preview.children[0]?.taskSpecHash,
    );
    const id = one.prepared.preview.children[0]?.requestId ?? "";
    await expect(facade.result(bytes(two), id)).rejects.toThrow(
      "issuer_publication_binding_mismatch",
    );
    await expect(facade.issue(bytes(two))).rejects.toThrow("github_publication_binding_conflict");
    expect(f.git.appends).toBe(1);
    expect(await facade.result(bytes(one), id)).toMatchObject({ state: "pending" });
  });
  it("refuses to retrofit a preparation onto a legacy unbound request", async () => {
    const f = issuerFixture(),
      p = await f.facade.prepare(f.input()),
      c = p.prepared.preview.children[0];
    if (!c) throw new Error("fixture");
    await f.bus.issue(
      Buffer.from(c.rawSpec),
      Buffer.from(c.taskMarkdown),
      c.recipientActorId,
      c.route,
    );
    await expect(f.facade.issue(bytes(p))).rejects.toThrow("github_publication_binding_conflict");
    await expect(f.facade.result(bytes(p), c.requestId)).rejects.toThrow(
      "issuer_publication_binding_mismatch",
    );
    expect(f.git.appends).toBe(1);
  });
  it("refuses registered publication on a store without the conditional operation", async () => {
    const f = issuerFixture(),
      p = await f.facade.prepare(f.input());
    Object.defineProperty(f.git, "appendConditional", { value: undefined });
    await expect(f.facade.issue(bytes(p))).rejects.toThrow("issuer_conditional_append_unavailable");
    expect(f.git.appends).toBe(0);
  });
  it("refuses secret-shaped diagnostic strings in signed discovery", async () => {
    const f = issuerFixture();
    f.capability.actions.start.reason = "api_key_private_secret";
    await expect(f.facade.catalogue()).rejects.toThrow("issuer_capability_invalid");
  });
});

describe("scoped shared issuer template", () => {
  it("reuses the same read-only recipe without issue or a request ID", async () => {
    const f = issuerFixture();
    const value = (await f.facade.template(f.projectId, f.destination.destinationId)) as {
      templateOnly: boolean;
      executable: boolean;
      taskSpecTemplate: Record<string, unknown>;
    };
    expect(value.templateOnly).toBe(true);
    expect(value.executable).toBe(false);
    expect(value.taskSpecTemplate).not.toHaveProperty("request_id");
    expect(f.git.appends).toBe(0);
  });
  it("requires both host scope and signed-capability model membership", async () => {
    const f = issuerFixture();
    await expect(f.facade.template(randomUUID(), f.destination.destinationId)).rejects.toThrow(
      "issuer_scope_denied",
    );
    f.capability.modelIds = ["another-model"];
    await expect(f.facade.template(f.projectId, f.destination.destinationId)).rejects.toThrow(
      "issuer_capability_binding_mismatch",
    );
    expect(f.git.appends).toBe(0);
  });
});

describe("atomic registered fanout and identity boundary", () => {
  it("publishes one preparation with all children in one atomic append", async () => {
    const f = issuerFixture(),
      d = { ...structuredClone(f.destination), destinationId: "destination-b" };
    f.destinations.push(d);
    f.session.allowedDestinationIds.push(d.destinationId);
    const cap = { ...structuredClone(f.capability), destinationId: d.destinationId };
    f.capabilities.push({ codec: f.recipient.codec, current: () => cap });
    const facade = createIssuerSession(f.options);
    const input = f.input();
    input.identities.requestIds.push(randomUUID());
    const group = randomUUID();
    Object.assign(input.identities, { fanoutId: group });
    input.request.destinations.push({
      destinationId: d.destinationId,
      modelId: d.modelIds[0] ?? "",
    });
    const p = await facade.prepare(input);
    await facade.issue(bytes(p));
    expect(f.git.appends).toBe(1);
    expect(f.git.files.has(`bridge-v2/workflows/${group}.json`)).toBe(true);
    for (const c of p.prepared.preview.children) {
      const raw = await f.git.read(
        await f.git.snapshot(),
        f.bus.path("outbox", c.requestId, "issuer_preparation.json"),
      );
      expect(raw).toEqual(bytes(p));
      expect(await facade.result(bytes(p), c.requestId)).toMatchObject({ state: "pending" });
    }
  });
  it("denies malformed/duplicate host identities without issue", async () => {
    const f = issuerFixture(),
      input = f.input();
    Object.assign(input.identities, { requestIds: null });
    await expect(f.facade.prepare(input)).rejects.toThrow("issuer_arguments_invalid");
    expect(f.git.appends).toBe(0);
    expect(f.prepare).not.toHaveBeenCalled();
    const duplicate = f.input();
    duplicate.identities.previewId = duplicate.identities.requestIds[0] ?? "";
    await expect(f.facade.prepare(duplicate)).rejects.toThrow();
    expect(f.git.appends).toBe(0);
  });
});

describe("scoped capability disclosure and historical fanout", () => {
  it("redacts out-of-scope project references while preserving observation time", async () => {
    const f = issuerFixture();
    const hidden = randomUUID();
    f.capability.projects.push({
      projectId: hidden,
      registryRevision: 1,
      snapshotSha256: "b".repeat(64),
    });
    const value = (await f.facade.catalogue()) as {
      capabilities: {
        signedBase64: string;
        capability: { projects: unknown[]; observedAt: string };
      }[];
    };
    expect(JSON.stringify(value)).not.toContain(hidden);
    expect(value.capabilities[0]?.capability.projects).toHaveLength(1);
    expect(value.capabilities[0]?.capability.observedAt).toBe(f.capability.observedAt);
    const prepared = await f.facade.prepare(f.input());
    await f.facade.issue(bytes(prepared));
    expect(f.git.appends).toBe(1);
  });
  it("allows a new same-requester session to collect only its scoped historical child", async () => {
    const f = issuerFixture(),
      d = { ...structuredClone(f.destination), destinationId: "destination-b" };
    f.destinations.push(d);
    f.session.allowedDestinationIds.push(d.destinationId);
    const cap = { ...structuredClone(f.capability), destinationId: d.destinationId };
    f.capabilities.push({ codec: f.recipient.codec, current: () => cap });
    const facade = createIssuerSession(f.options),
      input = f.input();
    input.identities.requestIds.push(randomUUID());
    Object.assign(input.identities, { fanoutId: randomUUID() });
    input.request.destinations.push({
      destinationId: d.destinationId,
      modelId: d.modelIds[0] ?? "",
    });
    const prepared = await facade.prepare(input);
    await facade.issue(bytes(prepared));
    f.advance(60000);
    f.session.sessionId = randomUUID();
    f.session.allowedDestinationIds = [d.destinationId];
    await expect(
      facade.result(bytes(prepared), input.identities.requestIds[1] ?? ""),
    ).resolves.toMatchObject({ state: "pending" });
    await expect(
      facade.result(bytes(prepared), input.identities.requestIds[0] ?? ""),
    ).rejects.toThrow("issuer_scope_denied");
    expect(f.git.appends).toBe(1);
  });
  it("fails closed on an accidentally asynchronous final append fence", async () => {
    const f = issuerFixture(),
      prepared = await f.facade.prepare(f.input()),
      child = prepared.prepared.preview.children[0];
    if (!child) throw new Error("fixture");
    await expect(
      f.bus.issue(
        Buffer.from(child.rawSpec),
        Buffer.from(child.taskMarkdown),
        child.recipientActorId,
        child.route,
        undefined,
        undefined,
        async () => {
          throw new Error("late_private_error");
        },
      ),
    ).rejects.toThrow("transport_append_guard_must_be_synchronous");
    await Promise.resolve();
    expect(f.git.appends).toBe(0);
  });
});
