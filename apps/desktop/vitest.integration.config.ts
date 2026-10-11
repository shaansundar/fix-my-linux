import { defineConfig } from "vitest/config";

/** Runs the real bundled opencode binary; fetch it first with `node scripts/fetch-opencode.ts --host`. */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
