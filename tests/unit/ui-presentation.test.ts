import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPresentationStore, type PresentationStore } from "../../src/ui/presentation.js";
import { startUiServer, type UiServerHandle } from "../../src/ui/server.js";

describe("persistent cosmetic presentation preferences", () => {
  let directory: string;
  const stores: PresentationStore[] = [];
  const servers: UiServerHandle[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bridge-presentation-"));
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const store of stores.splice(0)) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function open() {
    const store = await openPresentationStore(directory);
    stores.push(store);
    return store;
  }
  it("persists theme and desktop choices without any task or secret fields", async () => {
    const first = await open();
    expect(first.snapshot()).toMatchObject({
      revision: 1,
      values: {
        theme: "light",
        alwaysOnTop: false,
        hideWhenInactive: false,
        minimizeToTray: false,
        completionNotifications: true,
      },
    });
    const changed = first.update(
      {
        expectedRevision: 1,
        patch: { theme: "dark", alwaysOnTop: true, completionNotifications: false },
      },
      true,
    );
    expect(changed.revision).toBe(2);
    const second = await open();
    expect(second.snapshot()).toEqual(changed);
    expect(Object.keys(changed.values).sort()).toEqual([
      "alwaysOnTop",
      "completionNotifications",
      "hideWhenInactive",
      "minimizeToTray",
      "theme",
    ]);
  });
  it("rejects stale competing writes and never silently resets a preference", async () => {
    const first = await open(),
      second = await open();
    first.update({ expectedRevision: 1, patch: { theme: "dark" } }, false);
    expect(() =>
      second.update({ expectedRevision: 1, patch: { completionNotifications: false } }, false),
    ).toThrow("settings changed");
    expect(second.snapshot().values.theme).toBe("dark");
    second.update({ expectedRevision: 2, patch: { completionNotifications: false } }, false);
    expect(first.snapshot().values).toMatchObject({
      theme: "dark",
      completionNotifications: false,
    });
  });
  it("rejects authority, secrets, unknown properties, empty patches and native-only changes in a browser", async () => {
    const store = await open();
    for (const patch of [
      { secret: "example" },
      { task: "x" },
      { theme: "system" },
      { alwaysOnTop: "yes" },
      {},
    ])
      expect(() => store.update({ expectedRevision: 1, patch }, true)).toThrow();
    expect(() =>
      store.update({ expectedRevision: 1, patch: { alwaysOnTop: true } }, false),
    ).toThrow("desktop Bridge app");
    expect(store.snapshot().revision).toBe(1);
  });
  it("observes saves without allowing listeners to change saved values", async () => {
    const store = await open();
    let count = 0;
    const off = store.subscribe((value) => {
      count++;
      value.values.theme = "light";
      throw new Error("observer failed");
    });
    store.update({ expectedRevision: 1, patch: { theme: "dark" } }, false);
    expect(store.snapshot().values.theme).toBe("dark");
    expect(count).toBe(1);
    off();
    store.update({ expectedRevision: 2, patch: { theme: "light" } }, false);
    expect(count).toBe(1);
  });
  it("protects preferences through the same authenticated HTTP boundary", async () => {
    const server = await startUiServer({
      stateDir: directory,
      profile: "demo",
      nativeControls: true,
    });
    servers.push(server);
    expect((await fetch(`${server.origin}/api/presentation`)).status).toBe(401);
    const headers = { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };
    const saved = await fetch(`${server.origin}/api/presentation`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedRevision: 1,
        patch: { theme: "dark", hideWhenInactive: true },
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      profile: "demo",
      presentation: { revision: 2, values: { theme: "dark", hideWhenInactive: true } },
      nativeControls: { available: true },
    });
    expect(server.service.bootstrap().tasks).toEqual([]);
    const stale = await fetch(`${server.origin}/api/presentation`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 1, patch: { theme: "light" } }),
    });
    expect(stale.status).toBe(409);
  });
});
