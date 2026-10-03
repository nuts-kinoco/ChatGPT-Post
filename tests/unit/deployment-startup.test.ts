/** Inert trusted modules only; no provider/credential/process execution. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTrustedDeployment } from "../../src/adapters/deployment-loader.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function moduleFile(source: string) {
  const root = await mkdtemp(join(process.cwd(), ".deployment-startup-"));
  roots.push(root);
  const path = join(root, "host.mjs");
  await writeFile(path, source, { mode: 0o600 });
  return path;
}
describe("optional deployment startup cancellation", () => {
  it("denies an already-aborted startup before filesystem or import", async () => {
    const c = new AbortController();
    c.abort();
    await expect(
      openTrustedDeployment("/does-not-exist/host.mjs", { signal: c.signal }),
    ).rejects.toThrow("deployment_startup_aborted");
  });
  it("never invokes the factory after cancellation during a pending import", async () => {
    const key = `startup_${randomUUID().replaceAll("-", "")}`;
    const host = globalThis as unknown as Record<string, unknown>;
    const path = await moduleFile(
      `globalThis['${key}']='importing'; await new Promise(r=>setTimeout(r,40)); export async function openDeployment(){globalThis['${key}']='factory'; return {};}`,
    );
    const c = new AbortController();
    const pending = openTrustedDeployment(path, { signal: c.signal });
    const denial = expect(pending).rejects.toThrow("deployment_startup_aborted");
    for (let i = 0; i < 100 && !host[key]; i++) await new Promise((r) => setTimeout(r, 1));
    expect(host[key]).toBe("importing");
    c.abort();
    await denial;
    expect(host[key]).toBe("importing");
    delete host[key];
  });
  it("leaves legacy zero-argument factories unchanged", async () => {
    const path = await moduleFile(
      "export async function openDeployment(...args){return {count:args.length};}",
    );
    expect(await openTrustedDeployment(path)).toEqual({ count: 0 });
  });
  it("passes the same optional host signal into the factory", async () => {
    const path = await moduleFile(
      "export async function openDeployment(startup){return startup.signal;}",
    );
    const c = new AbortController();
    expect(await openTrustedDeployment(path, { signal: c.signal })).toBe(c.signal);
  });
});
