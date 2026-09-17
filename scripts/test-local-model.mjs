import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const result = spawnSync(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "tests/integration/local-model-smoke.test.ts"], {
  env: { ...process.env, RUN_LOCAL_MODEL_TEST: "1" }, stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
