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
        "src/plugins/core/tools.ts",
        "src/tools/bash.ts",
        "src/tools/approval.ts",
        "src/tools/file_edit.ts",
        "src/tools/file_read.ts",
        "src/tools/file_write.ts",
        "src/tools/memory.ts",
        "src/tools/registry.ts",
        "src/tools/search.ts",
        "src/tools/skill.ts",
        "src/tools/web_fetch.ts",
        "src/tools/workspace-path.ts",
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
