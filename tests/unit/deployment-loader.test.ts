import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTrustedDeployment } from "../../src/adapters/deployment-loader.js";
import { startUiServer } from "../../src/ui/server.js";

const dirs: string[] = [];
async function file() {
  const dir = await mkdtemp(join(tmpdir(), "deployment-trust-"));
  dirs.push(dir);
  const path = join(dir, "host.mjs");
  await writeFile(path, 'throw new Error("must_not_execute_untrusted_module");', { mode: 0o600 });
  return path;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe("trusted deployment module loader", () => {
  it.each(["relative.mjs", "/trusted/config.json"])(
    "rejects non-explicit executable configuration %s",
    async (path) => {
      await expect(openTrustedDeployment(path)).rejects.toThrow("deployment_path_required");
    },
  );
  it("rejects a replaceable public temporary ancestor without importing code", async () => {
    const path = await file();
    await chmod(dirname(path), 0o777);
    await expect(openTrustedDeployment(path)).rejects.toThrow(
      /deployment_(directory_untrusted|windows_acl_verifier_unavailable)/,
    );
  });
  it("rejects an alias before importing code", async () => {
    const path = await file();
    const alias = `${path}-alias.mjs`;
    await symlink(path, alias);
    await expect(openTrustedDeployment(alias)).rejects.toThrow("deployment_symlink_denied");
  });
  it("rejects a writable deployment module without executing it", async () => {
    const path = await file();
    await chmod(path, 0o666);
    await expect(openTrustedDeployment(path)).rejects.toThrow(
      /deployment_(file_untrusted|windows_acl_verifier_unavailable)/,
    );
  });
  it("cannot mix a deployment with a synthetic UI profile", async () => {
    await expect(
      startUiServer({
        profile: "demo",
        stateDir: "/tmp/unused",
        deploymentModule: "/trusted/unused.mjs",
      }),
    ).rejects.toThrow("deployment_profile_conflict");
  });
});
