import { afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export function isolateGitConfig(): void {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(resolve(tmpdir(), "breeze-coder-git-config-"));
    const path = resolve(directory, "config");
    writeFileSync(path, "");
    vi.stubEnv("GIT_CONFIG_GLOBAL", path);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
}
