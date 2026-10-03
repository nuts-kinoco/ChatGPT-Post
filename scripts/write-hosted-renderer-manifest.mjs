/** Trusted build only. Audits this finite compiled import graph; never accepts a module/root argument. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, posix } from "node:path";
import ts from "typescript";
import {
  HOSTED_BUILD_BUILTINS, HOSTED_BUILD_ENTRYPOINT, HOSTED_BUILD_FILES, HOSTED_BUILD_GRAPH_PATH,
  HOSTED_BUILD_IMPORTS, HOSTED_BUILD_MANIFEST_PATH, HOSTED_BUILD_MODULES, HOSTED_CONSTANT_MANIFEST_PATH,
} from "../dist/prompt-rendering/hosted-build-spec.js";

if (process.argv.length !== 2) throw new Error("hosted_build_arguments_forbidden");
const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const read = (path) => {
  let current = root;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || (stats.isFile() && stats.nlink !== 1)) throw new Error(`hosted_build_alias:${path}`);
  }
  const stats = lstatSync(current);
  if (!stats.isFile() || stats.size > 16 * 1024 * 1024) throw new Error(`hosted_build_file_invalid:${path}`);
  return readFileSync(current);
};
const found = [];
for (const from of HOSTED_BUILD_MODULES) {
  const source = ts.createSourceFile(from, read(from).toString("utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier) || node.attributes) throw new Error(`hosted_build_import_invalid:${from}`);
        const specifier = node.moduleSpecifier.text;
        if (!specifier.startsWith("node:") && !specifier.startsWith("./") && !specifier.startsWith("../"))
          throw new Error(`hosted_build_external_import:${from}:${specifier}`);
        const target = specifier.startsWith("node:") ? specifier : posix.normalize(posix.join(posix.dirname(from), specifier));
        if (!HOSTED_BUILD_BUILTINS.includes(target) && !HOSTED_BUILD_MODULES.includes(target))
          throw new Error(`hosted_build_unresolved_import:${from}:${specifier}`);
        found.push({ from, specifier, target });
      }
    }
    if ((ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
           (ts.isIdentifier(node.expression) && ["require", "eval", "createRequire", "Function"].includes(node.expression.text)))) ||
        (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function"))
      throw new Error(`hosted_build_dynamic_code_forbidden:${from}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
}
found.sort((a, b) => {
  const x = `${a.from}\0${a.specifier}\0${a.target}`, y = `${b.from}\0${b.specifier}\0${b.target}`;
  return x < y ? -1 : x > y ? 1 : 0;
});
if (JSON.stringify(found) !== JSON.stringify(HOSTED_BUILD_IMPORTS)) throw new Error("hosted_build_audited_graph_mismatch");
const packageInfo = JSON.parse(read("package.json"));
if (packageInfo.type !== "module" || packageInfo.imports !== undefined || packageInfo.exports !== undefined)
  throw new Error("hosted_build_package_resolution_changed");
// This fixed module is imported only after its entire finite compiled dependency graph was checked.
const { productionConstantManifestBytes } = await import("../dist/prompt-rendering/production-profile.js");
const graph = canonical(found);
writeFileSync(join(root, HOSTED_BUILD_GRAPH_PATH), graph);
writeFileSync(join(root, HOSTED_CONSTANT_MANIFEST_PATH), productionConstantManifestBytes());
const files = HOSTED_BUILD_FILES.map((path) => {
  const bytes = read(path);
  return { path, kind: path.endsWith(".js") ? "javascript" : "json", sha256: hash(bytes), sizeBytes: bytes.byteLength };
});
if (files.reduce((total, file) => total + file.sizeBytes, 0) > 256 * 1024 * 1024) throw new Error("hosted_build_total_too_large");
const manifest = canonical({
  schema: "bridge-renderer-build-manifest-1", rendererId: "bridge-hosted-prompt-1", rendererVersion: 1,
  entrypoint: HOSTED_BUILD_ENTRYPOINT,
  runtime: { kind: "node", compatibilityProfile: "bridge-node-runtime-1", additionalLoaders: [] },
  importGraphSha256: hash(graph), builtinModules: [...HOSTED_BUILD_BUILTINS], files,
});
if (manifest.byteLength > 1024 * 1024) throw new Error("hosted_build_manifest_too_large");
writeFileSync(join(root, HOSTED_BUILD_MANIFEST_PATH), manifest);
console.log(`hosted renderer manifest ${hash(manifest)} (${files.length} fixed files)`);
