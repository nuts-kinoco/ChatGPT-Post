/** Trusted-host synthetic profile. No arbitrary task argv/env, credential reads or login operations. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { checkedDirectory } from "../archive/paths.js";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";

export interface ClaudeSdkHostProfile {
  schema: "claude-sdk-host-profile-1";
  profileId: number;
  revision: number;
  assurance: "trusted-host-and-provider-controls";
  trustAdminPolicy: true;
  recipientId: string;
  approverId: string;
  policySha256: string;
  executable: string;
  binarySha256: string;
  cliVersion: "2.1.288";
  cwd: string;
  home: string;
  configDirectory: string;
  approvedAuthContextId: string;
  providerRouteId: "claude-first-party-existing-subscription";
  authMethod: "claude.ai";
  allowedBuiltinPlugins: readonly string[];
}
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v) && v.length === 64;
const id = (v: unknown) =>
  typeof v === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(v) && v.length <= 64;
const fixedEnvironment = Object.freeze({
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
});
export const CLAUDE_TEXT_ENVIRONMENT_POLICY_SHA256 = sha256Bytes(
  Buffer.from(
    JSON.stringify({
      schema: "claude-text-environment-policy-1",
      fixed: fixedEnvironment,
      hostPathKeys: ["HOME", "CLAUDE_CONFIG_DIR"],
      inheritance: "none",
      credentialEnvironment: "none",
    }),
  ),
);
function validateProfile(value: ClaudeSdkHostProfile): ClaudeSdkHostProfile {
  const v = structuredClone(value);
  const keys = [
    "schema",
    "profileId",
    "revision",
    "assurance",
    "trustAdminPolicy",
    "recipientId",
    "approverId",
    "policySha256",
    "executable",
    "binarySha256",
    "cliVersion",
    "cwd",
    "home",
    "configDirectory",
    "approvedAuthContextId",
    "providerRouteId",
    "authMethod",
    "allowedBuiltinPlugins",
  ];
  if (
    !v ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k)) ||
    v.schema !== "claude-sdk-host-profile-1" ||
    v.assurance !== "trusted-host-and-provider-controls" ||
    v.trustAdminPolicy !== true ||
    !Number.isSafeInteger(v.profileId) ||
    v.profileId < 1 ||
    v.profileId > 0xffffffff ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 1 ||
    !id(v.recipientId) ||
    !id(v.approverId) ||
    !hash(v.policySha256) ||
    !hash(v.binarySha256) ||
    v.cliVersion !== "2.1.288" ||
    !id(v.approvedAuthContextId) ||
    v.providerRouteId !== "claude-first-party-existing-subscription" ||
    v.authMethod !== "claude.ai" ||
    ![v.executable, v.cwd, v.home, v.configDirectory].every(
      (p) =>
        typeof p === "string" &&
        isAbsolute(p) &&
        resolve(p) === p &&
        ![...p].some((c) => c.charCodeAt(0) < 32),
    ) ||
    !Array.isArray(v.allowedBuiltinPlugins) ||
    v.allowedBuiltinPlugins.length !== 0 ||
    v.allowedBuiltinPlugins.some((p) => typeof p !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(p))
  )
    throw new Error("text_host_profile_invalid");
  return v;
}
export function sdkProfileEnvironment(profile: ClaudeSdkHostProfile): Record<string, string> {
  const v = validateProfile(profile);
  return { ...fixedEnvironment, HOME: v.home, CLAUDE_CONFIG_DIR: v.configDirectory };
}
export interface ClaudeSdkProbeObservation {
  schema: "claude-text-probe-observation-1";
  cliVersion: "2.1.288";
  binarySha256: string;
  supportedFlagsSha256: string;
  authStatusSha256: string;
  localManagedMetadataSha256: string;
  auth: {
    loggedIn: true;
    authMethod: "claude.ai";
    apiProvider: "firstParty";
    configDirectoryMatches: true;
  };
  profileRevision: number;
  approvedAuthContextId: string;
  providerRouteId: ClaudeSdkHostProfile["providerRouteId"];
  observedAt: string;
}
/** Drops account/email/config paths and every unknown field rather than hashing secrets or raw diagnostics. */
export function validateClaudeSdkProbe(
  profile: ClaudeSdkHostProfile,
  evidence: {
    version: Uint8Array;
    help: Uint8Array;
    auth: Uint8Array;
    binarySha256: string;
    managedMetadata: unknown;
    observedAt: Date;
  },
): ClaudeSdkProbeObservation {
  const p = validateProfile(profile);
  if (
    evidence.version.byteLength > 4096 ||
    evidence.help.byteLength > 262144 ||
    evidence.auth.byteLength > 65536
  )
    throw new Error("text_host_probe_bounds");
  const decoder = new TextDecoder("utf8", { fatal: true }),
    version = decoder.decode(evidence.version).trim(),
    help = decoder.decode(evidence.help);
  if (version !== `${p.cliVersion} (Claude Code)` || evidence.binarySha256 !== p.binarySha256)
    throw new Error("text_host_installation_changed");
  const required = [
    "--safe-mode",
    "--restricted",
    "--tools",
    "--disallowedTools",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--permission-prompts",
    "--output-format",
    "--input-format",
  ];
  if (required.some((flag) => !help.includes(flag)))
    throw new Error("text_host_capability_missing");
  const a = parseStrictJsonBytes(evidence.auth) as Record<string, unknown>;
  if (
    !a ||
    Array.isArray(a) ||
    a.loggedIn !== true ||
    a.authMethod !== p.authMethod ||
    a.apiProvider !== "firstParty" ||
    a.configDirectory !== p.configDirectory
  )
    throw new Error("text_host_auth_unavailable");
  const auth = {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    configDirectoryMatches: true,
  } as const;
  // A local managed file is not automatically dangerous. This bounded profile supports only the observed absent set;
  // another host needs a reviewed metadata policy rather than reading or modifying administrator contents.
  const absent = [
    "/etc/claude-code",
    "/etc/claude-code/managed-settings.json",
    "/etc/claude-code/managed-settings.d",
    "/etc/claude-code/managed-mcp.json",
  ].map((path) => ({ path, state: "absent" }));
  if (JSON.stringify(evidence.managedMetadata) !== JSON.stringify(absent))
    throw new Error("text_host_managed_metadata_out_of_profile");
  return {
    schema: "claude-text-probe-observation-1",
    cliVersion: p.cliVersion,
    binarySha256: p.binarySha256,
    supportedFlagsSha256: sha256Bytes(
      Buffer.from(
        JSON.stringify({
          required,
          installedHelpSha256: sha256Bytes(evidence.help),
          documentedHiddenFlags: ["--max-turns"],
          documentation: "https://code.claude.com/docs/en/cli-reference",
        }),
      ),
    ),
    authStatusSha256: sha256Bytes(Buffer.from(JSON.stringify(auth))),
    localManagedMetadataSha256: sha256Bytes(Buffer.from(JSON.stringify(absent))),
    auth,
    profileRevision: p.revision,
    approvedAuthContextId: p.approvedAuthContextId,
    providerRouteId: p.providerRouteId,
    observedAt: evidence.observedAt.toISOString(),
  };
}
async function fileHash(path: string): Promise<string> {
  let cursor = dirname(path);
  while (true) {
    const st = lstatSync(cursor);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      (st.uid !== 0 && st.uid !== process.getuid?.()) ||
      ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0)
    )
      throw new Error("text_host_binary_untrusted");
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 4 ||
    before.size > 1024 * 1024 * 1024 ||
    (before.uid !== 0 && before.uid !== process.getuid?.()) ||
    (before.mode & 0o6022) !== 0 ||
    !(before.mode & 0o111)
  )
    throw new Error("text_host_binary_untrusted");
  const hash = createHash("sha256");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const opened = fstatSync(fd);
  if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size) {
    closeSync(fd);
    throw new Error("text_host_installation_changed");
  }
  for await (const b of createReadStream(path, { fd, autoClose: true })) hash.update(b);
  const after = lstatSync(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error("text_host_installation_changed");
  return hash.digest("hex");
}
function metadataOnly(): unknown {
  return [
    "/etc/claude-code",
    "/etc/claude-code/managed-settings.json",
    "/etc/claude-code/managed-settings.d",
    "/etc/claude-code/managed-mcp.json",
  ].map((path) => {
    try {
      const s = lstatSync(path);
      return {
        path,
        state: "present",
        kind: s.isDirectory() ? "directory" : s.isFile() ? "file" : "other",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, state: "absent" };
      throw new Error("text_host_metadata_unavailable");
    }
  });
}
function readOnlyCommand(p: ClaudeSdkHostProfile, args: readonly string[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    execFile(
      p.executable,
      [...args],
      {
        cwd: p.cwd,
        env: sdkProfileEnvironment(p),
        encoding: "buffer",
        timeout: 4000,
        maxBuffer: 262144,
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => {
        if (error)
          reject(
            new Error(args[0] === "auth" ? "text_host_auth_unavailable" : "text_host_probe_failed"),
          );
        else resolve(Buffer.from(stdout));
      },
    );
  });
}
/** Only these three documented metadata commands run. Calling this does not issue or invoke a model. */
export async function probeClaudeSdkHost(
  profile: ClaudeSdkHostProfile,
): Promise<ClaudeSdkProbeObservation> {
  const p = validateProfile(profile);
  if (process.platform !== "linux") throw new Error("text_host_platform_unsupported");
  checkedDirectory(p.cwd, {}, true);
  checkedDirectory(p.home);
  checkedDirectory(p.configDirectory);
  if (readdirSync(p.cwd).length !== 0) throw new Error("text_host_cwd_not_empty");
  const before = await fileHash(p.executable);
  if (before !== p.binarySha256) throw new Error("text_host_installation_changed");
  const start = Date.now();
  const version = await readOnlyCommand(p, ["--version"]),
    help = await readOnlyCommand(p, ["--help"]),
    auth = await readOnlyCommand(p, ["auth", "status"]);
  const after = await fileHash(p.executable);
  if (Date.now() - start > 12000 || before !== after || readdirSync(p.cwd).length !== 0)
    throw new Error("text_host_probe_changed_or_stale");
  return validateClaudeSdkProbe(p, {
    version,
    help,
    auth,
    binarySha256: after,
    managedMetadata: metadataOnly(),
    observedAt: new Date(),
  });
}
export function cloneClaudeSdkHostProfile(value: ClaudeSdkHostProfile): ClaudeSdkHostProfile {
  return validateProfile(value);
}
