import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const target = new URL("../dist/ui/public/", import.meta.url);
await mkdir(target, { recursive: true });
// Deliberate allowlist: no development fixtures, credentials or runtime records are packaged.
for (const file of ["index.html", "styles.css", "app.js"]) {
  await copyFile(
    fileURLToPath(new URL(`../src/ui/public/${file}`, import.meta.url)),
    fileURLToPath(new URL(file, target)),
  );
}
