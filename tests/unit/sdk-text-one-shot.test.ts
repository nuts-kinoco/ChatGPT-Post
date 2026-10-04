/** Composition only: no real key generation, provider/auth process, connector or filesystem publication. */
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdkFixture, syntheticAbsolute } from "../helpers/sdk-text-fixture.js";

const privateTrial = syntheticAbsolute("private", "trial");
const s = vi.hoisted(() => ({
  config: undefined as unknown,
  exists: false,
  probe: vi.fn(),
  keys: vi.fn(),
  close: vi.fn(),
  hostClose: vi.fn(),
  registryClose: vi.fn(),
  writes: vi.fn(),
  create: vi.fn(),
  grant: undefined as unknown as { approve(value: Record<string, unknown>): Promise<unknown> },
}));
vi.mock("node:crypto", async () => ({
  ...(await vi.importActual<typeof import("node:crypto")>("node:crypto")),
  generateKeyPairSync: s.keys,
  sign: () => Buffer.alloc(64),
}));
vi.mock("node:fs", async () => ({
  ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
  existsSync: () => s.exists,
}));
vi.mock("../../dist/archive/paths.js", () => ({
  checkedDirectory: vi.fn(),
  readOwnedFile: () => Buffer.from(JSON.stringify(s.config)),
  writeNewFile: s.writes,
}));
vi.mock("../../dist/archive/durable.js", () => ({
  rootIdentity: () => ({ device: "1", inode: "2" }),
  syncDirectory: vi.fn(),
  publishImmutableFiles: s.writes,
}));
vi.mock("../../dist/adapters/claude-sdk-profile.js", () => ({
  cloneClaudeSdkHostProfile: (p: unknown) => structuredClone(p),
  probeClaudeSdkHost: s.probe,
}));
vi.mock("../../dist/adapters/claude-sdk-text.js", () => ({
  sdkProfileDigest: () => "d".repeat(64),
}));
vi.mock("../../dist/state/project-registry.js", () => ({
  ProjectRegistry: class {
    configure() {}
    close() {
      s.registryClose();
    }
  },
}));
vi.mock("../../dist/adapters/github-connector-stdio.js", () => ({
  StdioGitHubConnectorHost: class {
    close() {
      s.hostClose();
    }
  },
}));
vi.mock("../../dist/adapters/github-connector-store.js", () => ({
  GitHubConnectorStore: class {},
}));
vi.mock("../../dist/adapters/github-transport.js", () => ({
  GitHubTaskBus: class {},
  SignedBusCodec: class {},
}));
vi.mock("../../dist/adapters/sdk-text-bus.js", () => ({ GitHubSdkTextBus: class {} }));
vi.mock("../../dist/adapters/sdk-text-deployment.js", () => ({
  generateSdkTextRequest: () => ({
    request: {
      requestId: "00000000-0000-4000-8000-000000000001",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    },
    rawRequest: "{}",
    markdown: "synthetic",
    requestSha256: "a".repeat(64),
  }),
  createSdkTextDeployment: s.create,
}));

// @ts-expect-error The shipped example is JavaScript, imported only after all host ports are replaced.
import { openDeployment } from "../../examples/sdk-text-one-shot.mjs";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.resetAllMocks();
  s.exists = false;
  const f = sdkFixture();
  s.config = {
    schema: "sdk-text-one-shot-configuration-1",
    profile: f.profile,
    privateRoot: privateTrial,
    requesterId: "requester",
    registry: {
      schema: "bridge-project-registry-1",
      revision: 1,
      defaultOutputRoot: syntheticAbsolute("private", "output"),
      projects: [
        {
          projectId: f.request.projectRegistration.projectId,
          repoId: "product-a",
          storageSlug: "product-a",
          displayName: "Synthetic",
          githubDestination: f.request.destination,
          outputRootOverride: null,
        },
      ],
    },
  };
  vi.stubEnv("BRIDGE_SDK_TRIAL_APPROVAL", "one-haiku-query-and-two-ephemeral-signing-keys");
  vi.stubEnv("BRIDGE_SDK_TRIAL_CONFIG", syntheticAbsolute("private", "config.json"));
  const signals = new EventEmitter();
  vi.stubGlobal("process", {
    ...process,
    on: signals.on.bind(signals),
    off: signals.off.bind(signals),
    emit: signals.emit.bind(signals),
    argv: [
      "node",
      syntheticAbsolute("bridge", "dist", "cli", "sdk-text.js"),
      "--deployment",
      syntheticAbsolute("bridge", "examples", "sdk-text-one-shot.mjs"),
      "trial",
      join(privateTrial, "trial-input", "request.json"),
      join(privateTrial, "trial-input", "task.md"),
    ],
  });
  s.probe.mockResolvedValue({});
  s.keys.mockReturnValue({ publicKey: { export: () => "synthetic-public-key" }, privateKey: {} });
  s.close.mockResolvedValue(undefined);
  s.create.mockImplementation(async (v) => {
    s.grant = v.authority;
    return { close: s.close };
  });
});
describe("one-shot SDK host example", () => {
  it("requires explicit operator activation before probes/keys/storage", async () => {
    vi.stubEnv("BRIDGE_SDK_TRIAL_APPROVAL", "");
    await expect(openDeployment()).rejects.toThrow("approval_required");
    expect(s.probe).not.toHaveBeenCalled();
    expect(s.keys).not.toHaveBeenCalled();
  });
  it("refuses read-only commands before probes or keys", async () => {
    process.argv[4] = "status";
    await expect(openDeployment()).rejects.toThrow("command_required");
    expect(s.probe).not.toHaveBeenCalled();
    expect(s.keys).not.toHaveBeenCalled();
  });
  it("does not regenerate a previous key intent", async () => {
    s.exists = true;
    await expect(openDeployment()).rejects.toThrow("already_admitted");
    expect(s.keys).not.toHaveBeenCalled();
    expect(s.probe).not.toHaveBeenCalled();
  });
  it("auth failure creates neither keys nor intent", async () => {
    s.probe.mockRejectedValueOnce(new Error("auth_unavailable"));
    await expect(openDeployment()).rejects.toThrow("auth_unavailable");
    expect(s.keys).not.toHaveBeenCalled();
    expect(s.writes).not.toHaveBeenCalled();
  });
  it("constructs exactly two transient signers and one runtime after the probe", async () => {
    await openDeployment();
    expect(s.keys).toHaveBeenCalledTimes(2);
    expect(s.create).toHaveBeenCalledTimes(1);
    expect(s.probe.mock.invocationCallOrder[0]).toBeLessThan(s.keys.mock.invocationCallOrder[0]);
    expect(s.writes.mock.invocationCallOrder[0]).toBeLessThan(s.keys.mock.invocationCallOrder[0]);
  });
  it("authority accepts only the generated identity/hash/profile and bounded expiry", async () => {
    await openDeployment();
    const v = {
      requestId: "00000000-0000-4000-8000-000000000001",
      requestSha256: "a".repeat(64),
      profileSha256: "d".repeat(64),
      approverId: "operator",
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      maxStarts: 1,
    };
    await expect(s.grant.approve(v)).resolves.toMatchObject({ requestSha256: v.requestSha256 });
    for (const bad of [
      { ...v, requestSha256: "e".repeat(64) },
      { ...v, profileSha256: "e".repeat(64) },
      { ...v, maxStarts: 2 },
      { ...v, expiresAt: new Date(Date.now() + 600000).toISOString() },
    ])
      await expect(s.grant.approve(bad)).rejects.toThrow("authority_denied");
  });
  it("retains relay/registry across failed drain, closes same runtime on retry", async () => {
    const d = await openDeployment();
    s.close.mockRejectedValueOnce(new Error("drain_pending"));
    await expect(d.close()).rejects.toThrow("drain_pending");
    expect(s.hostClose).not.toHaveBeenCalled();
    expect(s.registryClose).not.toHaveBeenCalled();
    await d.close();
    await d.close();
    expect(s.close).toHaveBeenCalledTimes(2);
    expect(s.hostClose).toHaveBeenCalledTimes(1);
    expect(s.registryClose).toHaveBeenCalledTimes(1);
  });
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  it(`stops during startup probe before key intent or keys: ${signal}`, async () => {
    const signals = new EventEmitter();
    Object.assign(process, {
      on: signals.on.bind(signals),
      off: signals.off.bind(signals),
      emit: signals.emit.bind(signals),
    });
    let release!: () => void;
    s.probe.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const running = openDeployment();
    const denied = expect(running).rejects.toThrow("sdk_text_stopping");
    process.emit(signal);
    release();
    await denied;
    expect(s.keys).not.toHaveBeenCalled();
    expect(s.writes).not.toHaveBeenCalled();
    expect(signals.listenerCount(signal)).toBe(0);
  });
}

it("refuses a startup signal already aborted before the factory", async () => {
  const c = new AbortController();
  c.abort();
  await expect(openDeployment({ signal: c.signal })).rejects.toThrow("sdk_text_stopping");
  expect(s.probe).not.toHaveBeenCalled();
  expect(s.keys).not.toHaveBeenCalled();
  expect(s.writes).not.toHaveBeenCalled();
});
it("carries optional startup signal across the probe without a process event", async () => {
  const c = new AbortController();
  let release!: () => void;
  s.probe.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
  const p = openDeployment({ signal: c.signal });
  const denied = expect(p).rejects.toThrow("sdk_text_stopping");
  c.abort();
  release();
  await denied;
  expect(s.keys).not.toHaveBeenCalled();
  expect(s.writes).not.toHaveBeenCalled();
});
