/** Real task terminal/signature flow, synthetic materialization port; no provider/IPC/network. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TaskController } from "../../src/state/task-controller.js";
import { UnavailableTaskExecutor } from "../../src/state/task-executor.js";
import { openTaskStore } from "../../src/state/task-store.js";
import { adapterPolicy } from "../helpers/adapter-fixture.js";
import { issuerFixture } from "../helpers/issuer-fixture.js";
import { fixtureManifest, fixtureReceipt } from "../helpers/materialization-fixture.js";

async function delivery() {
  const f = issuerFixture(),
    p = await f.facade.prepare(f.input()),
    raw = Buffer.from(p.signedPreparationBase64, "base64"),
    c = p.prepared.preview.children[0];
  if (!c) throw new Error("fixture");
  await f.facade.issue(raw);
  const root = await mkdtemp(join(tmpdir(), "issuer-delivery-")),
    store = await openTaskStore(join(root, "jobs.db"));
  const controller = new TaskController(
    store,
    new UnavailableTaskExecutor(),
    adapterPolicy(root, new Date()),
  );
  controller.receive(Buffer.from(c.rawSpec), Buffer.from(c.taskMarkdown), null, "requester");
  await controller.cancel(c.requestId);
  const terminal = store.handshake(c.requestId, "terminal_result");
  if (!terminal) throw new Error("fixture");
  await f.recipient.publish(terminal, store.deliveryPayload(c.requestId));
  await fixtureManifest(f.recipient, c.requestId);
  const materialize = vi.fn(async (context) => fixtureReceipt(context));
  f.options.materialize = materialize;
  return {
    ...f,
    p,
    raw,
    c,
    terminal,
    materialize,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
describe("issuer historical terminal and proof ACK", () => {
  it("retrieves only its bound result and uses the configured materializer before real signed ACK", async () => {
    const f = await delivery();
    try {
      f.advance(60000);
      expect(await f.facade.result(f.raw, f.c.requestId)).toMatchObject({
        event: { eventId: f.terminal.eventId },
        result: { status: "cancelled" },
      });
      await f.facade.acknowledge(f.raw, f.c.requestId, f.terminal.payloadSha256);
      expect(f.materialize).toHaveBeenCalledTimes(1);
      expect(
        await f.bus.readEvent(await f.git.snapshot(), f.c.requestId, "result_ack"),
      ).toMatchObject({ payloadSha256: f.terminal.payloadSha256 });
    } finally {
      await f.close();
    }
  });
  it("checks exact terminal hash before materialization", async () => {
    const f = await delivery();
    try {
      await expect(f.facade.acknowledge(f.raw, f.c.requestId, "a".repeat(64))).rejects.toThrow(
        "issuer_ack_binding_changed",
      );
      expect(f.materialize).not.toHaveBeenCalled();
      expect(f.git.files.has(f.bus.path("outbox", f.c.requestId, "result_ack.json"))).toBe(false);
    } finally {
      await f.close();
    }
  });
  it("scope expiration during ACK signing leaves local materialization but publishes no ACK", async () => {
    const f = await delivery();
    try {
      const before = f.git.appends;
      f.signerHooks.requester = async () => {
        f.advance(3600001);
      };
      await expect(
        f.facade.acknowledge(f.raw, f.c.requestId, f.terminal.payloadSha256),
      ).rejects.toThrow("issuer_session_expired");
      expect(f.materialize).toHaveBeenCalledTimes(1);
      expect(f.git.appends).toBe(before);
      expect(f.git.files.has(f.bus.path("outbox", f.c.requestId, "result_ack.json"))).toBe(false);
    } finally {
      await f.close();
    }
  });
  it("no configured materializer cannot turn payload presence into ACK", async () => {
    const f = await delivery();
    try {
      delete f.options.materialize;
      await expect(
        f.facade.acknowledge(f.raw, f.c.requestId, f.terminal.payloadSha256),
      ).rejects.toThrow("delivery_materializer_unconfigured");
      expect(f.git.files.has(f.bus.path("outbox", f.c.requestId, "result_ack.json"))).toBe(false);
    } finally {
      await f.close();
    }
  });
});
