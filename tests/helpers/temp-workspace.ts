import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensureWorkspace } from "../../src/workspace/workspace.js";

export function createTempWorkspace(config: Record<string, unknown> = {}): string {
  const workspacePath = mkdtempSync(resolve(tmpdir(), "tiny-claw-test-"));
  ensureWorkspace(workspacePath);
  writeFileSync(
    resolve(workspacePath, "config.json"),
    `${JSON.stringify({
      apiUrl: "https://example.com/api",
      apiKey: "test-api-key",
      model: "test-model",
      ...config,
    }, null, 2)}\n`,
    "utf-8",
  );
  return workspacePath;
}

export function removeTempWorkspace(workspacePath: string): void {
  rmSync(workspacePath, { recursive: true, force: true });
}
