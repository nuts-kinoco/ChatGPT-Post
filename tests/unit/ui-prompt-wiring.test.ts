/** Exercise the exact installed compiled bundle under standard Node, without a provider call. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("passes all 30 installed-bundle composer/issuer synthetic scenarios without a model or browser", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      fileURLToPath(new URL("../helpers/ui-prompt-wiring-scenario.mjs", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  expect(output).toContain("# pass 30");
  expect(output).toContain("# fail 0");
});
