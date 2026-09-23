import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempWorkspace } from "../helpers/temp-workspace.js";
import { desktopUserDataPath, initializeDesktopWorkspace } from "../../desktop/workspace.js";

describe("desktop workspace", () => {
  it("uses the branded data directory, preserves data and honors explicit overrides", () => {
    const appData = createTempWorkspace();
    try {
      const userData = resolve(appData, "breeze-coder");
      const workspace = initializeDesktopWorkspace(userData);
      writeFileSync(resolve(workspace, "config.json"), '{"existing":true}');
      expect(desktopUserDataPath(appData)).toBe(userData);
      expect(initializeDesktopWorkspace(desktopUserDataPath(appData))).toBe(workspace);
      expect(readFileSync(resolve(workspace, "config.json"), "utf8")).toBe('{"existing":true}');
      expect(desktopUserDataPath(appData, "isolated-test")).toBe(resolve("isolated-test"));
    } finally {
      rmSync(appData, { recursive: true, force: true });
    }
  });
  it("creates the workspace structure without owning config generation", () => {
    const userDataPath = createTempWorkspace();
    const workspacePath = initializeDesktopWorkspace(userDataPath);

    expect(workspacePath).toBe(resolve(userDataPath, "workspace"));
    expect(existsSync(resolve(workspacePath, "skills"))).toBe(true);
    expect(existsSync(resolve(workspacePath, "plugins"))).toBe(true);
  });
});
