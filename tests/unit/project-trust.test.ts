import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../../src/config.js";
import { isTrustedProject, projectTempDirectory, setProjectTrust } from "../../src/security/project-trust.js";
import { createBashTool } from "../../src/tools/bash.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("explicit project trust", () => {
  it("persists settings and revokes cached session trust", () => {
    const workspace = createTempWorkspace();
    const root = createTempWorkspace();
    try {
      const cached = loadConfig(workspace);
      expect(isTrustedProject(cached, root, workspace)).toBe(false);
      setProjectTrust(workspace, root, true);
      expect(isTrustedProject(cached, root, workspace)).toBe(true);
      const trusted = loadConfig(workspace);
      expect(isTrustedProject(trusted, root)).toBe(true);
      setProjectTrust(workspace, root, false);
      expect(isTrustedProject(trusted, root, workspace)).toBe(false);
    } finally { removeTempWorkspace(workspace); removeTempWorkspace(root); }
  });
  it("matches exact canonical roots and gives each project a controlled TMPDIR", async () => {
    const workspace = createTempWorkspace();
    const root = createTempWorkspace();
    const other = createTempWorkspace();
    try {
      const config = loadConfig(workspace);
      expect(isTrustedProject(config, root)).toBe(false);
      config.security = { mode: "auto", trustedProjects: [root] };
      mkdirSync(resolve(root, "child"));
      symlinkSync(root, resolve(workspace, "alias"), "junction");
      expect(isTrustedProject(config, resolve(workspace, "alias"))).toBe(true);
      expect(isTrustedProject(config, resolve(root, "child"))).toBe(false);
      const temp = projectTempDirectory(workspace, root);
      expect(temp).not.toBe(projectTempDirectory(workspace, other));
      const result = await createBashTool(workspace, () => config).execute({ command: 'echo hello > "$TMPDIR/test.log"; echo "$TMPDIR"' }, {
        rootPath: root, config, restrictToRoot: true, sessionContext: { mode: "project", project: { root, name: "test" } },
      });
      expect(JSON.parse(result).exitCode).toBe(0);
      expect(JSON.parse(result).stdout.trim()).not.toBe("");
      expect(readFileSync(resolve(temp, "test.log"), "utf8").trim()).toBe("hello");
      symlinkSync(other, resolve(temp, "escape"), "junction");
      expect(await createBashTool(workspace, () => config).execute({ command: 'echo hello > "$TMPDIR/escape/out"' }, {
        rootPath: root, config, sessionContext: { mode: "project", project: { root, name: "test" } },
      })).toContain("requiresConfirmation");
    } finally { removeTempWorkspace(workspace); removeTempWorkspace(root); removeTempWorkspace(other); }
  });
  it.each([
    { trustedProjects: ["relative"] }, { trustedProjects: ["C:relative"] }, { trustedProjects: [""] }, { trustedProjects: "all" },
    { background: { maxRunning: 0 } }, { background: { timeoutSeconds: -1 } },
  ])("validates execution configuration: %j", (security) => {
    const root = createTempWorkspace({ security });
    try { expect(() => loadConfig(root)).toThrow(); } finally { removeTempWorkspace(root); }
  });
});
