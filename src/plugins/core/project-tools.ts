import type { Plugin } from "../types.js";
import { loadConfig } from "../../config.js";
import { createProjectTreeTool } from "../../tools/project-tree.js";
import { createProjectSearchTool } from "../../tools/project-search.js";
import { createGitDiffTool, createGitStatusTool } from "../../tools/project-git.js";
import { withAudit } from "./tools.js";

export const coreProjectToolsPlugin: Plugin = {
  name: "core-project-tools",
  async init(ctx) {
    const getConfig = () => loadConfig(ctx.workspacePath);
    const tools = [
      createProjectTreeTool(ctx.workspacePath, getConfig),
      createProjectSearchTool(ctx.workspacePath, getConfig),
      createGitStatusTool(ctx.workspacePath, getConfig),
      createGitDiffTool(ctx.workspacePath, getConfig),
    ];
    for (const tool of tools) ctx.registerTool(withAudit(ctx.workspacePath, tool));
  },
};
