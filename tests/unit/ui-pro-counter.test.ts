import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ProCounterSettings,
  ProObservationStore,
  type ProSubmissionObservation,
  validateProSettings,
} from "../../src/ui/pro-counter.js";

const START = "2026-10-03T08:00:00.000Z";
const ATTEMPT = "2026-10-03T08:00:01.000Z";
const END = "2026-10-03T09:00:00.000Z";
const settings = (): ProCounterSettings => ({
  limit: 10,
  warnRemaining: 2,
  startsAt: START,
  endsAt: END,
  timeZone: "Etc/UTC",
  otherUsage: null,
});
function observation(overrides: Partial<ProSubmissionObservation> = {}): ProSubmissionObservation {
  return {
    requestId: randomUUID(),
    attemptId: randomUUID(),
    revision: 1,
    attemptedAt: ATTEMPT,
    observedAt: ATTEMPT,
    submitted: "yes",
    observedPreset: "pro",
    source: "trusted-ordinary-chat-observer",
    synthetic: false,
    ...overrides,
  };
}
describe("Bridge-observed Pro counter", () => {
  let directory: string;
  let now: string;
  const stores: ProObservationStore[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bridge-pro-counter-"));
    now = START;
  });
  afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  function open(synthetic = false, filename = `${randomUUID()}.db`) {
    const store = new ProObservationStore(
      join(directory, filename),
      synthetic,
      () => new Date(now),
    );
    stores.push(store);
    return store;
  }
  it("starts unknown, never claims provider or whole-account quota, and has no automatic reset", () => {
    const store = open();
    expect(store.view()).toMatchObject({
      version: "bridge-pro-counter-1",
      wholeAccountKnown: false,
      providerQuotaKnown: false,
      windowState: "unconfigured",
      remaining: null,
      warning: { severity: "unknown" },
    });
    store.configure(settings(), 0);
    now = END;
    expect(store.view()).toMatchObject({ windowState: "expired", remaining: null, confirmed: 0 });
    now = "2026-10-04T08:00:00.000Z";
    expect(store.view().windowState).toBe("expired");
    expect(store.configuration()?.revision).toBe(1);
  });
  it("validates complete settings, canonical timestamps, bounded numbers and explicit timezones", () => {
    expect(() => validateProSettings(settings())).not.toThrow();
    for (const invalid of [
      { ...settings(), startsAt: "2026-10-03T08:00:00Z" },
      { ...settings(), endsAt: START },
      { ...settings(), limit: 0 },
      { ...settings(), limit: 1.5 },
      { ...settings(), warnRemaining: 11 },
      { ...settings(), timeZone: "Imaginary/Island" },
      { ...settings(), startsAt: null },
      { ...settings(), secret: "no" },
      null,
    ])
      expect(() => validateProSettings(invalid)).toThrow();
  });
  it("deduplicates the exact request+attempt and guards monotonic revision and confirmed counts", () => {
    const store = open();
    store.configure(settings(), 0);
    const observed = observation();
    store.observe(observed);
    store.observe(observed);
    store.observe({ ...observed, revision: 2 });
    store.observe({ ...observed, observedPreset: "unknown" }); // stale, not a downgrade
    expect(store.view()).toMatchObject({
      confirmed: 1,
      possible: 0,
      remaining: { lower: 9, upper: 9 },
    });
    expect(() => store.observe({ ...observed, revision: 2, observedPreset: "unknown" })).toThrow(
      "different content",
    );
    expect(() => store.observe({ ...observed, revision: 3, observedPreset: "other" })).toThrow(
      "downgraded",
    );
    expect(() => store.observe({ ...observed, revision: 3, attemptedAt: START })).toThrow(
      "rewritten",
    );
  });
  it("keeps uncertain submissions as a range and refines an existing attempt without double counting", () => {
    const store = open();
    store.configure({ ...settings(), otherUsage: 2 }, 0);
    store.observe(observation());
    const uncertain = observation({ submitted: "unknown", observedPreset: "unknown" });
    store.observe(uncertain);
    store.observe(observation({ submitted: "no" }));
    store.observe(observation({ observedPreset: "other" }));
    expect(store.view()).toMatchObject({
      confirmed: 1,
      possible: 1,
      remaining: { lower: 6, upper: 7 },
      otherUsage: { value: 2, source: "user-reported-unverified" },
    });
    store.observe({ ...uncertain, revision: 2, submitted: "yes", observedPreset: "pro" });
    expect(store.view()).toMatchObject({
      confirmed: 2,
      possible: 0,
      remaining: { lower: 6, upper: 6 },
    });
  });
  it("uses configured reference counts only and warns conservatively at the lower range", () => {
    const store = open();
    store.configure({ ...settings(), limit: 2, warnRemaining: 1 }, 0);
    store.observe(observation({ submitted: "unknown" }));
    expect(store.view()).toMatchObject({
      remaining: { lower: 1, upper: 2, source: "configured-reference-only" },
      warning: { active: true, severity: "warning" },
      providerQuotaKnown: false,
      wholeAccountKnown: false,
    });
  });
  it("pins late observations to the configuration at attempt time, not current settings", () => {
    const store = open();
    const original = store.configure(settings(), 0);
    now = "2026-10-03T08:30:00.000Z";
    const current = store.configure(
      { ...settings(), startsAt: now, endsAt: "2026-10-03T09:30:00.000Z" },
      1,
    );
    expect(current.windowId).not.toBe(original.windowId);
    store.observe(observation({ observedAt: now }));
    expect(store.view()).toMatchObject({ confirmed: 0, possible: 0, unassignedInWindow: 0 });
  });
  it("does not retroactively assign a pre-configuration observation to a newly configured window", () => {
    const store = open();
    store.observe(observation());
    now = "2026-10-03T08:30:00.000Z";
    store.configure(settings(), 0);
    expect(store.view()).toMatchObject({
      confirmed: 0,
      unassignedInWindow: 1,
      remaining: null,
      warning: { severity: "unknown" },
    });
  });
  it("preserves window identity for limit/warning edits and rejects stale settings revisions", () => {
    const store = open();
    const original = store.configure(settings(), 0);
    store.observe(observation());
    now = "2026-10-03T08:30:00.000Z";
    const updated = store.configure({ ...settings(), limit: 20, warnRemaining: 4 }, 1);
    expect(updated.windowId).toBe(original.windowId);
    expect(store.view()).toMatchObject({ confirmed: 1, remaining: { lower: 19, upper: 19 } });
    expect(() => store.configure(settings(), 1)).toThrow("changed");
  });
  it("keeps original observation pins but marks overlapping newly configured windows uncertain", () => {
    const store = open();
    store.configure(settings(), 0);
    store.observe(observation());
    now = "2026-10-03T08:30:00.000Z";
    store.configure({ ...settings(), endsAt: "2026-10-03T10:00:00.000Z" }, 1);
    expect(store.view()).toMatchObject({ confirmed: 0, unassignedInWindow: 1, remaining: null });
  });
  it("does not regain remaining reference counts by only changing the timezone label", () => {
    const store = open();
    store.configure(settings(), 0);
    store.observe(observation());
    now = "2026-10-03T08:30:00.000Z";
    store.configure({ ...settings(), timeZone: "America/New_York" }, 1);
    const view = store.view();
    expect(view.confirmed === 1 || view.remaining === null).toBe(true);
  });
  it("separates synthetic profiles and validates the trusted source and observation timestamp", () => {
    const store = open(false, "profile.db");
    expect(() => open(true, "profile.db")).toThrow("separate stores");
    for (const invalid of [
      { ...observation(), synthetic: true },
      { ...observation(), source: "user" },
      { ...observation(), observedAt: START },
      { ...observation(), revision: 0 },
      { ...observation(), attemptedAt: "invalid" },
      { ...observation(), requestId: "latest" },
    ])
      expect(() => store.observe(invalid as ProSubmissionObservation)).toThrow("trusted");
  });
  it("persists observations and configuration across restart", () => {
    let store = open(false, "persist.db");
    store.configure(settings(), 0);
    store.observe(observation());
    store.close();
    stores.splice(stores.indexOf(store), 1);
    store = open(false, "persist.db");
    expect(store.view()).toMatchObject({
      confirmed: 1,
      remaining: { lower: 9, upper: 9 },
      configuration: { revision: 1 },
    });
  });
  it("accepts semantically identical retries regardless of object field insertion order", () => {
    const store = open();
    store.configure(settings(), 0);
    const input = observation();
    store.observe(input);
    const reordered = Object.fromEntries(
      Object.entries(input).reverse(),
    ) as unknown as ProSubmissionObservation;
    expect(() => store.observe(reordered)).not.toThrow();
    expect(store.view().confirmed).toBe(1);
  });
  it("fails closed when an observation body or pinned window is corrupted", () => {
    const store = open(false, "corrupt.db");
    store.configure(settings(), 0);
    const input = observation();
    store.observe(input);
    const db = new DatabaseSync(join(directory, "corrupt.db"));
    try {
      const row = db.prepare("SELECT body FROM pro_counter_observations").get() as { body: string };
      const original = JSON.parse(row.body);
      for (const corrupted of [
        { ...original, submitted: "no", countState: "not_pro" },
        { ...original, windowId: null },
        { ...original, revision: 2 },
        { ...original, countState: "possible_pro" },
      ]) {
        db.prepare("UPDATE pro_counter_observations SET body=?").run(JSON.stringify(corrupted));
        expect(() => store.view()).toThrow("remaining usage is unknown");
        expect(() => store.observe({ ...input, revision: 2 })).toThrow(
          "remaining usage is unknown",
        );
      }
      db.prepare("UPDATE pro_counter_observations SET body=?").run(row.body);
      expect(store.view().confirmed).toBe(1);
    } finally {
      db.close();
    }
  });
  it("fails closed on settings integrity loss and does not silently backfill unchecked legacy history", () => {
    const store = open(false, "settings.db");
    store.configure(settings(), 0);
    const db = new DatabaseSync(join(directory, "settings.db"));
    try {
      const row = db.prepare("SELECT body FROM pro_counter_settings").get() as { body: string };
      const config = JSON.parse(row.body);
      config.settings.limit = 100;
      db.prepare("UPDATE pro_counter_settings SET body=?").run(JSON.stringify(config));
      expect(() => store.configuration()).toThrow("remaining usage is unknown");
      db.prepare("UPDATE pro_counter_settings SET body=?,digest=NULL").run(row.body);
      expect(() => store.view()).toThrow("remaining usage is unknown");
      expect(() => store.configure(settings(), 1)).toThrow("remaining usage is unknown");
    } finally {
      db.close();
    }
  });
  it("rejects extra observation fields and later revisions with backwards observation time", () => {
    const store = open();
    store.configure(settings(), 0);
    const input = observation({ observedAt: "2026-10-03T08:10:00.000Z" });
    store.observe(input);
    expect(() =>
      store.observe({ ...input, extra: "ignored authority" } as ProSubmissionObservation),
    ).toThrow("trusted");
    expect(() =>
      store.observe({ ...input, revision: 2, observedAt: "2026-10-03T08:05:00.000Z" }),
    ).toThrow("rewritten");
  });
});
