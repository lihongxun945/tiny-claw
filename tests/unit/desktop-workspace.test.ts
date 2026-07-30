import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempWorkspace } from "../helpers/temp-workspace.js";
import { initializeDesktopWorkspace } from "../../desktop/workspace.js";

describe("desktop workspace", () => {
  it("creates the workspace structure without owning config generation", () => {
    const userDataPath = createTempWorkspace();
    const workspacePath = initializeDesktopWorkspace(userDataPath);

    expect(workspacePath).toBe(resolve(userDataPath, "workspace"));
    expect(existsSync(resolve(workspacePath, "skills"))).toBe(true);
    expect(existsSync(resolve(workspacePath, "plugins"))).toBe(true);
  });
});
