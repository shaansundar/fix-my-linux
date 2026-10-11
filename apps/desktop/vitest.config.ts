import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src/renderer") } },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: ["test/integration/**", "test/e2e/**", "**/node_modules/**"],
    environment: "node",
    coverage: { provider: "v8", include: ["src/main/**", "src/shared/**"] },
  },
});
