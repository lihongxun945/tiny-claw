import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Config, Tool, ToolExecutionContext } from "../types.js";
import { checkDangerousToolPermission } from "./permission.js";
import { resolveRootFile } from "./workspace-path.js";

const DEFAULT_EXCLUDED_NAMES = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".cache"]);

export function createProjectTreeTool(workspacePath: string, getConfig: () => Config): Tool {
  return {
    name: "project_tree",
    description: "读取当前项目的目录树。仅在项目会话中可用，自动跳过依赖、版本库和常见构建目录。",
    isAvailable: (context) => context.mode === "project",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "项目内的相对目录，默认项目根目录" },
        depth: { type: "number", description: "遍历深度，不得超过项目配置上限" },
      },
    },
    execute: async (args, context) => {
      const project = getProjectExecution(context);
      if ("error" in project) return JSON.stringify(project);
      const config = context?.config ?? getConfig();
      const maxDepth = config.project?.treeMaxDepth ?? 4;
      const maxEntries = config.project?.treeMaxEntries ?? 2000;
      const requestedDepth = typeof args.depth === "number" ? Math.floor(args.depth) : maxDepth;
      if (requestedDepth < 1 || requestedDepth > maxDepth) {
        return JSON.stringify({ error: `depth 必须在 1 到 ${maxDepth} 之间` });
      }

      let start: string;
      try {
        start = resolveRootFile(project.root, typeof args.path === "string" ? args.path : ".");
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
      const permission = checkDangerousToolPermission({
        workspacePath,
        config,
        toolName: "project_tree",
        args,
        context,
        command: `tree ${relative(project.root, start) || "."}`,
        cwd: project.root,
      });
      if (!permission.allowed) return permission.result;

      const entries: Array<{ path: string; type: "file" | "directory" | "symlink" }> = [];
      let truncated = false;
      const walk = async (directory: string, depth: number): Promise<void> => {
        if (context?.signal?.aborted) throw new Error("项目目录读取已取消");
        const children = await readdir(directory, { withFileTypes: true });
        children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const child of children) {
          if (DEFAULT_EXCLUDED_NAMES.has(child.name)) continue;
          if (entries.length >= maxEntries) {
            truncated = true;
            return;
          }
          const absolutePath = resolve(directory, child.name);
          const itemPath = relative(project.root, absolutePath);
          const type = child.isSymbolicLink() ? "symlink" : child.isDirectory() ? "directory" : "file";
          entries.push({ path: itemPath, type });
          if (child.isDirectory() && depth < requestedDepth) await walk(absolutePath, depth + 1);
          if (truncated) return;
        }
      };

      try {
        await walk(start, 1);
        return JSON.stringify({ root: relative(project.root, start) || ".", depth: requestedDepth, entries, truncated });
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

function getProjectExecution(context?: ToolExecutionContext): { root: string } | { error: string } {
  if (context?.sessionContext?.mode !== "project" || !context.rootPath || !context.restrictToRoot) {
    return { error: "project_tree 仅可在项目会话中使用" };
  }
  return { root: context.rootPath };
}
