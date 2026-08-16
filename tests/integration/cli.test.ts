import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { validateConfig } from "../../src/config.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("CLI startup", () => {
  const workspaces: string[] = [];

  function runCli(workspacePath: string) {
    return spawnSync(
      process.execPath,
      [resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/index.ts"), "--workspace", workspacePath],
      { cwd: process.cwd(), input: "", encoding: "utf-8", timeout: 30_000 },
    );
  }

  afterEach(() => {
    for (const workspacePath of workspaces.splice(0)) {
      removeTempWorkspace(workspacePath);
    }
  });

  it("creates a missing config before loading core plugins", () => {
    const workspacePath = createTempWorkspace();
    workspaces.push(workspacePath);
    const configPath = resolve(workspacePath, "config.json");
    rmSync(configPath);

    const result = runCli(workspacePath);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(configPath)).toBe(true);
    expect(() => validateConfig(JSON.parse(readFileSync(configPath, "utf-8")))).not.toThrow();
  });

  it("does not overwrite an existing config", () => {
    const workspacePath = createTempWorkspace();
    workspaces.push(workspacePath);
    const configPath = resolve(workspacePath, "config.json");
    const original = readFileSync(configPath, "utf-8");

    const result = runCli(workspacePath);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });
});
