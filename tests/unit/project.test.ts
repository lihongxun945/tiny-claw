import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { applySessionConfig, inspectProject, parseGitStatus, readProjectDiff, readProjectGitStatus } from "../../src/project.js";
import { createSessionMeta, readSessionMeta } from "../../src/session-store.js";
import { createFileWriteTool } from "../../src/tools/file_write.js";
import { loadConfig } from "../../src/config.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";

describe("project development context", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });

  it("inspects paths with shell metacharacters without shell interpolation", async () => {
    const parent = mkdtempSync(resolve(tmpdir(), "tiny-claw-project-parent-"));
    paths.push(parent);
    const root = resolve(parent, 'repo "$(echo unsafe)"');
    mkdirSync(root);
    writeFileSync(resolve(root, "package.json"), "{}", "utf-8");
    writeFileSync(resolve(root, "AGENTS.md"), "project rule", "utf-8");

    await expect(inspectProject(root)).resolves.toMatchObject({
      root: realpathSync(root),
      name: 'repo "$(echo unsafe)"',
      stack: ["Node.js / npm"],
      rules: expect.stringContaining("project rule"),
    });
  });

  it("uses ask by default for project sessions and applies tool overrides", () => {
    const workspace = createTempWorkspace({
      security: { mode: "allow", tools: {} },
      project: { security: { tools: { file_read: { mode: "allow" }, bash: { mode: "deny" } } } },
    });
    paths.push(workspace);
    const effective = applySessionConfig(loadConfig(workspace), {
      mode: "project",
      project: { root: workspace, name: "project" },
    });
    expect(effective.security?.mode).toBe("ask");
    expect(effective.security?.tools?.bash?.mode).toBe("deny");
    expect(effective.security?.tools?.file_read?.mode).toBe("allow");
    expect(effective.security?.tools?.project_search?.mode).toBe("allow");
  });

  it("parses staged, unstaged, untracked, and renamed git status records", () => {
    expect(parseGitStatus("M  staged.ts\0 M unstaged.ts\0?? new.ts\0R  renamed.ts\0old.ts\0")).toEqual([
      expect.objectContaining({ path: "staged.ts", staged: true, unstaged: false }),
      expect.objectContaining({ path: "unstaged.ts", staged: false, unstaged: true }),
      expect.objectContaining({ path: "new.ts", untracked: true }),
      expect.objectContaining({ path: "renamed.ts", previousPath: "old.ts", staged: true }),
    ]);
  });

  it("reads git status asynchronously and truncates diffs at the configured limit", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "tiny-claw-git-project-"));
    paths.push(root);
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
    writeFileSync(resolve(root, "tracked.txt"), "before\n", "utf-8");
    execFileSync("git", ["-C", root, "add", "tracked.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
    writeFileSync(resolve(root, "tracked.txt"), `after\n${"x".repeat(200)}\n`, "utf-8");

    await expect(readProjectGitStatus(root)).resolves.toMatchObject({
      isRepository: true,
      clean: false,
      changedCount: 1,
      files: [expect.objectContaining({ path: "tracked.txt", unstaged: true })],
    });
    await expect(readProjectDiff(root, "tracked.txt", 10_000, 40)).resolves.toMatchObject({
      path: "tracked.txt",
      truncated: true,
      unstaged: expect.any(String),
    });
  });

  it("persists an immutable project binding in session metadata", () => {
    const workspace = createTempWorkspace();
    paths.push(workspace);
    const first = { mode: "project" as const, project: { root: workspace, name: "one" } };
    createSessionMeta(workspace, "project-session", first);
    expect(readSessionMeta(workspace, "project-session")?.context).toEqual(first);
    expect(() => createSessionMeta(workspace, "project-session", { mode: "chat" })).toThrow("不能切换项目");
  });

  it("prevents project file writes from escaping the project root", async () => {
    const workspace = createTempWorkspace({ security: { mode: "allow" } });
    paths.push(workspace);
    const project = mkdtempSync(resolve(tmpdir(), "tiny-claw-project-root-"));
    paths.push(project);
    const tool = createFileWriteTool(workspace, () => loadConfig(workspace));
    const result = await tool.execute({ path: "../outside.txt", content: "blocked" }, {
      rootPath: project,
      restrictToRoot: true,
      config: applySessionConfig(loadConfig(workspace), { mode: "project", project: { root: project, name: "project" } }),
    });
    expect(JSON.parse(result).error).toContain("之外");
  });
});
