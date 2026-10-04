/** Pure candidate data only. No host inspection, credential reads, runtime or activation. */
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { types } from "node:util";

export interface WindowsSdkCandidatePaths {
  executable: string;
  cwd: string;
  home: string;
  configDirectory: string;
  systemRoot: string;
  programFiles: string;
}
export interface WindowsSdkCandidatePolicy {
  readonly schema: "claude-sdk-windows-candidate-policy-1";
  readonly paths: Readonly<WindowsSdkCandidatePaths>;
  readonly environment: Readonly<Record<string, string>>;
  readonly managedMetadataTargets: readonly (
    | { readonly kind: "file" | "directory"; readonly path: string }
    | { readonly kind: "registry"; readonly path: string; readonly valueName: "Settings" }
  )[];
  readonly policySha256: string;
}
const keys = [
  "executable",
  "cwd",
  "home",
  "configDirectory",
  "systemRoot",
  "programFiles",
] as const;
const fixedEnvironment = Object.freeze({
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
function pathValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !/^[A-Z]:\\/.test(value) ||
    /[<>"|?*/]/.test(value) ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    win32.normalize(value) !== value
  )
    throw new Error("sdk_windows_candidate_path_invalid");
  const segments = value.slice(3).split("\\");
  for (const segment of segments) {
    const basename = segment.split(".")[0]?.trim();
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.includes(":") ||
      /[. ]$/.test(segment) ||
      /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(basename ?? "")
    )
      throw new Error("sdk_windows_candidate_path_invalid");
  }
  return value;
}
/** Accept exactly six plain string fields; reject accessors/proxies/unknown keys before reading values. */
export function planWindowsSdkCandidatePolicy(input: unknown): WindowsSdkCandidatePolicy {
  if (!input || typeof input !== "object" || types.isProxy(input))
    throw new Error("sdk_windows_candidate_input_invalid");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("sdk_windows_candidate_input_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable;
    })
  )
    throw new Error("sdk_windows_candidate_input_invalid");
  const paths = Object.freeze({
    executable: pathValue(descriptors.executable?.value),
    cwd: pathValue(descriptors.cwd?.value),
    home: pathValue(descriptors.home?.value),
    configDirectory: pathValue(descriptors.configDirectory?.value),
    systemRoot: pathValue(descriptors.systemRoot?.value),
    programFiles: pathValue(descriptors.programFiles?.value),
  });
  if (!/\.exe$/i.test(paths.executable)) throw new Error("sdk_windows_candidate_path_invalid");
  const environment = Object.freeze({
    ...fixedEnvironment,
    SystemRoot: paths.systemRoot,
    WINDIR: paths.systemRoot,
    USERPROFILE: paths.home,
    HOME: paths.home,
    CLAUDE_CONFIG_DIR: paths.configDirectory,
  });
  const managedRoot = win32.join(paths.programFiles, "ClaudeCode");
  const managedMetadataTargets = Object.freeze([
    Object.freeze({ kind: "directory" as const, path: managedRoot }),
    Object.freeze({
      kind: "file" as const,
      path: win32.join(managedRoot, "managed-settings.json"),
    }),
    Object.freeze({
      kind: "directory" as const,
      path: win32.join(managedRoot, "managed-settings.d"),
    }),
    Object.freeze({ kind: "file" as const, path: win32.join(managedRoot, "managed-mcp.json") }),
    Object.freeze({
      kind: "registry" as const,
      path: "HKLM\\SOFTWARE\\Policies\\ClaudeCode",
      valueName: "Settings" as const,
    }),
    Object.freeze({
      kind: "registry" as const,
      path: "HKCU\\SOFTWARE\\Policies\\ClaudeCode",
      valueName: "Settings" as const,
    }),
  ]);
  const data = {
    schema: "claude-sdk-windows-candidate-policy-1" as const,
    paths,
    environment,
    managedMetadataTargets,
  };
  // Hash private candidate data in a fixed field order, never an observed or approved host claim.
  const policySha256 = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  return Object.freeze({ ...data, policySha256 });
}
