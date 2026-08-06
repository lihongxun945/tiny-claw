import type { Config, Tool, ToolExecutionContext } from "../types.js";
import { getProjectLimits, readProjectDiff, readProjectGitStatus } from "../project.js";
import { checkDangerousToolPermission } from "./permission.js";
import { relative } from "node:path";
import { resolveRootFile } from "./workspace-path.js";

export function createGitStatusTool(workspacePath: string, getConfig: () => Config): Tool {
  return {
    name: "git_status",
    description: "读取当前项目的 Git 分支、工作区状态和结构化变更文件列表。",
    isAvailable: (context) => context.mode === "project",
    inputSchema: { type: "object", properties: {} },
    execute: async (args, context) => {
      const project = getProjectExecution(context, "git_status");
      if ("error" in project) return JSON.stringify(project);
      const config = context?.config ?? getConfig();
      const permission = checkDangerousToolPermission({
        workspacePath, config, toolName: "git_status", args, context, command: "git status", cwd: project.root,
      });
      if (!permission.allowed) return permission.result;
      try {
        return JSON.stringify(await readProjectGitStatus(project.root, getProjectLimits(config).gitTimeoutMs));
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

export function createGitDiffTool(workspacePath: string, getConfig: () => Config): Tool {
  return {
    name: "git_diff",
    description: "读取当前项目全部变更或指定文件的 staged/unstaged Git Diff。",
    isAvailable: (context) => context.mode === "project",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string", description: "项目内文件路径；省略时返回全部变更" } },
    },
    execute: async (args, context) => {
      const project = getProjectExecution(context, "git_diff");
      if ("error" in project) return JSON.stringify(project);
      const config = context?.config ?? getConfig();
      let file: string | undefined;
      try {
        file = typeof args.file === "string" && args.file
          ? relative(project.root, resolveRootFile(project.root, args.file))
          : undefined;
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
      const permission = checkDangerousToolPermission({
        workspacePath, config, toolName: "git_diff", args, context, command: file ? `git diff -- ${file}` : "git diff", cwd: project.root,
      });
      if (!permission.allowed) return permission.result;
      try {
        const limits = getProjectLimits(config);
        return JSON.stringify(await readProjectDiff(project.root, file, limits.gitTimeoutMs, limits.diffMaxChars));
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

function getProjectExecution(context: ToolExecutionContext | undefined, toolName: string): { root: string } | { error: string } {
  if (context?.sessionContext?.mode !== "project" || !context.rootPath || !context.restrictToRoot) {
    return { error: `${toolName} 仅可在项目会话中使用` };
  }
  return { root: context.rootPath };
}
