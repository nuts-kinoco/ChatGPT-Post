import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_TEXT_ENVIRONMENT_POLICY_SHA256,
  type ClaudeSdkHostProfile,
  cloneClaudeSdkHostProfile,
  sdkProfileEnvironment,
} from "../../src/adapters/claude-sdk-profile.js";
import { planWindowsSdkCandidatePolicy } from "../../src/adapters/claude-sdk-windows-policy.js";
import { sdkFixture } from "../helpers/sdk-text-fixture.js";

const input = () => ({
  executable: "C:\\trusted\\claude.exe",
  cwd: "C:\\private\\empty",
  home: "C:\\Users\\Fixture",
  configDirectory: "C:\\Users\\Fixture\\.claude",
  systemRoot: "C:\\Windows",
  programFiles: "C:\\Program Files",
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const name of [
    "node:fs",
    "node:fs/promises",
    "node:child_process",
    "@anthropic-ai/claude-agent-sdk",
  ])
    vi.doUnmock(name);
  vi.resetModules();
});
describe("pure Windows SDK candidate policy", () => {
  it("returns private candidate data and unobserved managed source targets", () => {
    const plan = planWindowsSdkCandidatePolicy(input());
    expect(plan.schema).toBe("claude-sdk-windows-candidate-policy-1");
    expect(plan.paths).toEqual(input());
    expect(plan.managedMetadataTargets).toEqual([
      { kind: "directory", path: "C:\\Program Files\\ClaudeCode" },
      { kind: "file", path: "C:\\Program Files\\ClaudeCode\\managed-settings.json" },
      { kind: "directory", path: "C:\\Program Files\\ClaudeCode\\managed-settings.d" },
      { kind: "file", path: "C:\\Program Files\\ClaudeCode\\managed-mcp.json" },
      { kind: "registry", path: "HKLM\\SOFTWARE\\Policies\\ClaudeCode", valueName: "Settings" },
      { kind: "registry", path: "HKCU\\SOFTWARE\\Policies\\ClaudeCode", valueName: "Settings" },
    ]);
    expect(Object.keys(plan)).toEqual([
      "schema",
      "paths",
      "environment",
      "managedMetadataTargets",
      "policySha256",
    ]);
    for (const target of plan.managedMetadataTargets) expect(target).not.toHaveProperty("state");
    expect(plan).not.toHaveProperty("ready");
    expect(plan).not.toHaveProperty("available");
    expect(plan).not.toHaveProperty("authorized");
    expect(() => cloneClaudeSdkHostProfile(plan as unknown as ClaudeSdkHostProfile)).toThrow(
      "text_host_profile_invalid",
    );
  });
  it("uses an exact environment allowlist without inheriting ambient credentials or PATH", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-secret");
    vi.stubEnv("NODE_OPTIONS", "synthetic-options");
    const env = planWindowsSdkCandidatePolicy(input()).environment;
    expect(env).toEqual({
      CLAUDE_CODE_SAFE_MODE: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "512",
      MAX_THINKING_TOKENS: "0",
      CLAUDE_CODE_MAX_RETRIES: "0",
      CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: "0",
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      API_TIMEOUT_MS: "60000",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      USERPROFILE: "C:\\Users\\Fixture",
      HOME: "C:\\Users\\Fixture",
      CLAUDE_CONFIG_DIR: "C:\\Users\\Fixture\\.claude",
    });
    expect(JSON.stringify(env)).not.toContain("synthetic-secret");
    expect(env).not.toHaveProperty("PATH");
  });
  it.each([
    "relative",
    "C:relative",
    "\\root-relative",
    "\\\\server\\share\\file",
    "\\\\?\\C:\\file",
    "\\\\.\\pipe\\file",
    "/private/file",
    "C:/file",
    "c:\\file",
    "C:\\",
    "C:\\part\\",
    "C:\\part\\..\\file",
    "C:\\part\\.\\file",
    "C:\\part\\\\file",
    "C:\\part:stream",
    "C:\\part.",
    "C:\\part ",
    "C:\\CON",
    "C:\\NUL.txt",
    "C:\\CON .txt",
    "C:\\aux",
    "C:\\COM1.txt",
    "C:\\LPT².txt",
    "C:\\CONIN$",
    "C:\\CONOUT$",
    "C:\\wild*",
    "C:\\wild?",
    "C:\\bad|name",
    "C:\\bad<name",
    "C:\\bad>name",
    'C:\\bad"name',
    "C:\\bad\nname",
    "C:\\bad\0name",
    `C:\\${"x".repeat(1024)}`,
  ])("rejects unsupported path spelling %j", (cwd) => {
    expect(() => planWindowsSdkCandidatePolicy({ ...input(), cwd })).toThrow(
      "sdk_windows_candidate_path_invalid",
    );
  });
  it("checks every path and requires an explicit .exe candidate", () => {
    for (const key of Object.keys(input()))
      expect(() => planWindowsSdkCandidatePolicy({ ...input(), [key]: "relative" })).toThrow();
    for (const executable of [
      "C:\\trusted\\claude.cmd",
      "C:\\trusted\\claude.bat",
      "C:\\trusted\\claude",
    ])
      expect(() => planWindowsSdkCandidatePolicy({ ...input(), executable })).toThrow();
    expect(
      planWindowsSdkCandidatePolicy({ ...input(), executable: "D:\\Trusted Tool\\CLAUDE.EXE" })
        .paths.executable,
    ).toBe("D:\\Trusted Tool\\CLAUDE.EXE");
  });
  it.each(["env", "ANTHROPIC_API_KEY", "token", "password", "ready"])(
    "rejects secret or unknown input field %s without echoing its value",
    (key) => {
      try {
        planWindowsSdkCandidatePolicy({ ...input(), [key]: "synthetic-secret" });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("sdk_windows_candidate_input_invalid");
      }
    },
  );
  it("rejects non-string, missing, accessor, proxy and symbolic inputs without invoking getters", () => {
    const getter = vi.fn(() => "synthetic-secret");
    const accessor = input();
    Object.defineProperty(accessor, "home", { get: getter, enumerable: true });
    const missing = { ...input() } as Partial<ReturnType<typeof input>>;
    delete missing.home;
    const proxyTrap = vi.fn();
    const proxy = new Proxy(input(), { ownKeys: proxyTrap });
    for (const bad of [
      null,
      [],
      "secret",
      missing,
      accessor,
      proxy,
      { ...input(), [Symbol("secret")]: "synthetic-secret" },
      { ...input(), home: { toString: getter } },
    ])
      expect(() => planWindowsSdkCandidatePolicy(bad)).toThrow();
    expect(() => planWindowsSdkCandidatePolicy(accessor)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(proxyTrap).not.toHaveBeenCalled();
  });
  it("freezes copied data and keeps the digest stable across input property order", () => {
    const original = input(),
      plan = planWindowsSdkCandidatePolicy(original);
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    expect(planWindowsSdkCandidatePolicy(reordered)).toEqual(plan);
    expect(plan.policySha256).toBe(
      "64c591057674136a473537c1f56e99aaaf05ba648e4e40a8289a0c09776c0f5e",
    );
    expect(
      planWindowsSdkCandidatePolicy({ ...original, cwd: "C:\\private\\other" }).policySha256,
    ).not.toBe(plan.policySha256);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.paths)).toBe(true);
    expect(Object.isFrozen(plan.environment)).toBe(true);
    expect(Object.isFrozen(plan.managedMetadataTargets)).toBe(true);
    expect(plan.managedMetadataTargets.every(Object.isFrozen)).toBe(true);
    original.home = "C:\\Users\\Other";
    expect(plan.paths.home).toBe("C:\\Users\\Fixture");
  });
  it("imports and plans with filesystem/process/SDK imports and network effects forbidden", async () => {
    const forbidden = vi.fn(() => {
      throw new Error("external_effect_forbidden");
    });
    vi.resetModules();
    for (const name of [
      "node:fs",
      "node:fs/promises",
      "node:child_process",
      "@anthropic-ai/claude-agent-sdk",
    ])
      vi.doMock(name, forbidden);
    vi.stubGlobal("fetch", forbidden);
    const module = await import("../../src/adapters/claude-sdk-windows-policy.js");
    expect(module.planWindowsSdkCandidatePolicy(input())).toEqual(
      planWindowsSdkCandidatePolicy(input()),
    );
    module.planWindowsSdkCandidatePolicy(input());
    expect(forbidden).not.toHaveBeenCalled();
  });
  it("preserves the existing Linux environment policy hash and pure environment behavior", () => {
    const f = sdkFixture();
    expect(CLAUDE_TEXT_ENVIRONMENT_POLICY_SHA256).toBe(
      "2513d3cdd3cb17c3058dff0edeb72f058e29bc85ef06fa2cc166de0631ddfe19",
    );
    const env = sdkProfileEnvironment(f.profile);
    expect(env).toEqual({
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      CLAUDE_CODE_SAFE_MODE: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "512",
      MAX_THINKING_TOKENS: "0",
      CLAUDE_CODE_MAX_RETRIES: "0",
      CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: "0",
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      API_TIMEOUT_MS: "60000",
      HOME: f.profile.home,
      CLAUDE_CONFIG_DIR: f.profile.configDirectory,
    });
  });
});
