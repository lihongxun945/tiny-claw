import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/agent.ts",
        "src/config.ts",
        "src/history.ts",
        "src/plugin-manager.ts",
        "src/plugins/loader.ts",
        "src/tools/memory.ts",
        "src/tools/registry.ts",
        "src/tools/search.ts",
      ],
      thresholds: {
        statements: 75,
        branches: 65,
        functions: 75,
        lines: 75,
      },
    },
  },
});
