import { defineConfig } from "vitest/config";

const live = process.env.BRIDGE_LIVE === "1";

export default defineConfig({
  test: {
    include: live
      ? ["tests/live/**/*.test.ts"]
      : ["tests/unit/**/*.test.ts", "tests/fixture/**/*.test.ts"],
    testTimeout: live ? 1_200_000 : 20_000,
    hookTimeout: live ? 120_000 : 20_000,
    fileParallelism: !live,
  },
});
