/** Reviewed finite compiled dependency graph. Changes require a new build and policy pin. */
export const HOSTED_BUILD_ENTRYPOINT = "dist/prompt-rendering/hosted-renderer.js";
export const HOSTED_BUILD_MANIFEST_PATH = "dist/prompt-rendering/hosted-build-manifest.json";
export const HOSTED_BUILD_GRAPH_PATH = "dist/prompt-rendering/hosted-import-graph.json";
export const HOSTED_CONSTANT_MANIFEST_PATH = "dist/prompt-rendering/hosted-constant-manifest.json";
export const HOSTED_BUILD_MODULES = Object.freeze([
  "dist/contracts/output-contract-prompt.js",
  "dist/contracts/output-contract.js",
  "dist/contracts/raw-bytes.js",
  "dist/contracts/response-frame.js",
  "dist/prompt-rendering/brief.js",
  "dist/prompt-rendering/hosted-build-spec.js",
  "dist/prompt-rendering/hosted-build.js",
  "dist/prompt-rendering/hosted-registry.js",
  "dist/prompt-rendering/hosted-renderer.js",
  "dist/prompt-rendering/production-constants.js",
  "dist/prompt-rendering/production-profile.js",
]);
export const HOSTED_BUILD_BUILTINS = Object.freeze([
  "node:crypto",
  "node:fs",
  "node:path",
  "node:url",
]);
export interface HostedImportEdge {
  from: string;
  specifier: string;
  target: string;
}
const imports: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "dist/contracts/output-contract-prompt.js": [
    "./output-contract.js",
    "./raw-bytes.js",
    "./response-frame.js",
  ],
  "dist/contracts/output-contract.js": ["./raw-bytes.js", "./response-frame.js"],
  "dist/contracts/raw-bytes.js": ["node:crypto"],
  "dist/contracts/response-frame.js": ["./raw-bytes.js"],
  "dist/prompt-rendering/brief.js": ["../contracts/raw-bytes.js"],
  "dist/prompt-rendering/hosted-build-spec.js": [],
  "dist/prompt-rendering/hosted-build.js": [
    "../contracts/raw-bytes.js",
    "./brief.js",
    "./hosted-build-spec.js",
    "./production-profile.js",
  ],
  "dist/prompt-rendering/hosted-registry.js": [
    "node:fs",
    "node:path",
    "node:url",
    "../contracts/raw-bytes.js",
    "./brief.js",
    "./hosted-build-spec.js",
    "./hosted-build.js",
    "./production-profile.js",
  ],
  "dist/prompt-rendering/hosted-renderer.js": [
    "../contracts/output-contract-prompt.js",
    "../contracts/output-contract.js",
    "../contracts/raw-bytes.js",
    "../contracts/response-frame.js",
    "./brief.js",
    "./hosted-registry.js",
    "./production-constants.js",
    "./production-profile.js",
  ],
  "dist/prompt-rendering/production-constants.js": [
    "../contracts/output-contract-prompt.js",
    "../contracts/response-frame.js",
  ],
  "dist/prompt-rendering/production-profile.js": [
    "../contracts/raw-bytes.js",
    "./brief.js",
    "./production-constants.js",
  ],
});
function target(from: string, specifier: string): string {
  if (specifier.startsWith("node:")) return specifier;
  const parts = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}
export const HOSTED_BUILD_IMPORTS: readonly HostedImportEdge[] = Object.freeze(
  Object.entries(imports)
    .flatMap(([from, specifiers]) =>
      specifiers.map((specifier) =>
        Object.freeze({ from, specifier, target: target(from, specifier) }),
      ),
    )
    .sort((a, b) => {
      const x = `${a.from}\0${a.specifier}\0${a.target}`,
        y = `${b.from}\0${b.specifier}\0${b.target}`;
      return x < y ? -1 : x > y ? 1 : 0;
    }),
);
export const HOSTED_BUILD_FILES = Object.freeze(
  [
    ...HOSTED_BUILD_MODULES,
    HOSTED_BUILD_GRAPH_PATH,
    HOSTED_CONSTANT_MANIFEST_PATH,
    "package.json",
  ].sort(),
);
