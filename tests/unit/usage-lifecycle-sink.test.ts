import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageLifecycleJournal } from "../../src/state/usage-lifecycle.js";

const targetId = () => createHash("sha256").update(randomUUID()).digest("hex");

describe("source-owned lifecycle sink registration", () => {
  let dir: string;
  let db: DatabaseSync;
  let journal: UsageLifecycleJournal;
  const namespace = "notification-runtime-1";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lifecycle-sink-"));
    db = new DatabaseSync(join(dir, "source.db"));
    journal = new UsageLifecycleJournal(db);
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  it("persists exact target and actor across reopen and rejects a second sink before cursor use", () => {
    const binding = { targetId: targetId(), directActorId: "actor_one" };
    journal.registerLifecycleSink(namespace, binding);
    journal.registerLifecycleSink(namespace, { ...binding });
    expect(() =>
      journal.registerLifecycleSink(namespace, { ...binding, targetId: targetId() }),
    ).toThrow("usage_lifecycle_sink_conflict");
    expect(() =>
      journal.registerLifecycleSink(namespace, { ...binding, directActorId: "actor_two" }),
    ).toThrow("usage_lifecycle_sink_conflict");
    expect(journal.cursorPosition(namespace)).toBe(0);
    db.close();
    db = new DatabaseSync(join(dir, "source.db"));
    journal = new UsageLifecycleJournal(db);
    expect(() => journal.registerLifecycleSink(namespace, binding)).not.toThrow();
    expect(() =>
      journal.registerLifecycleSink(namespace, { ...binding, directActorId: null }),
    ).toThrow("usage_lifecycle_sink_conflict");
  });
  it("keeps namespaces independent and exact repeated owners compatible across database connections", () => {
    const binding = { targetId: targetId(), directActorId: null };
    journal.registerLifecycleSink(namespace, binding);
    const other = new DatabaseSync(join(dir, "source.db"));
    try {
      const sameSource = new UsageLifecycleJournal(other);
      expect(() => sameSource.registerLifecycleSink(namespace, binding)).not.toThrow();
      expect(() =>
        sameSource.registerLifecycleSink(namespace, { ...binding, targetId: targetId() }),
      ).toThrow("usage_lifecycle_sink_conflict");
      expect(() =>
        sameSource.registerLifecycleSink("another-runtime", {
          targetId: targetId(),
          directActorId: "actor_two",
        }),
      ).not.toThrow();
    } finally {
      other.close();
    }
  });
  it("fails closed on an already-advanced unbound legacy notification cursor", () => {
    db.prepare("INSERT INTO usage_lifecycle_cursors VALUES(?,4)").run(namespace);
    expect(() =>
      journal.registerLifecycleSink(namespace, { targetId: targetId(), directActorId: null }),
    ).toThrow("usage_lifecycle_sink_binding_unavailable");
    expect(journal.cursorPosition(namespace)).toBe(4);
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_lifecycle_sinks").get()?.n).toBe(0);
  });
  it("does not reset or change an existing cursor when the same registered owner reattaches", () => {
    const binding = { targetId: targetId(), directActorId: null };
    journal.registerLifecycleSink(namespace, binding);
    db.prepare("INSERT INTO usage_lifecycle_cursors VALUES(?,4)").run(namespace);
    journal.registerLifecycleSink(namespace, binding);
    expect(() =>
      journal.registerLifecycleSink(namespace, { ...binding, targetId: targetId() }),
    ).toThrow("usage_lifecycle_sink_conflict");
    expect(() =>
      journal.registerLifecycleSink(namespace, { ...binding, directActorId: "different_actor" }),
    ).toThrow("usage_lifecycle_sink_conflict");
    expect(journal.cursorPosition(namespace)).toBe(4);
  });
  it("validates the exact namespace, target hash and actor binding and rejects corrupted registration", () => {
    const good = { targetId: targetId(), directActorId: "actor_one" };
    for (const invalid of [
      { ...good, targetId: "not-a-uuid" },
      { ...good, directActorId: "Actor" },
      { ...good, directActorId: undefined },
      { ...good, extra: true },
    ])
      expect(() => journal.registerLifecycleSink(namespace, invalid as typeof good)).toThrow(
        "usage_lifecycle_sink_invalid",
      );
    for (const name of ["", "UPPER", "a".repeat(65), "space name"])
      expect(() => journal.registerLifecycleSink(name, good)).toThrow(
        "usage_lifecycle_sink_invalid",
      );
    journal.registerLifecycleSink(namespace, good);
    db.prepare("UPDATE usage_lifecycle_sinks SET digest='invalid' WHERE namespace=?").run(
      namespace,
    );
    expect(() => journal.registerLifecycleSink(namespace, good)).toThrow(
      "usage_lifecycle_sink_integrity_unavailable",
    );
  });
});
