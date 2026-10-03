import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/unit/cli-ipc.platform.ts"], pool: "forks" },
});
