import type { Plugin } from "../types.js";
import { createWebSearchTool } from "../../tools/search.js";
import { createWebFetchTool } from "../../tools/web_fetch.js";
import { createBashTool } from "../../tools/bash.js";
import { createFileReadTool } from "../../tools/file_read.js";
import { createFileWriteTool } from "../../tools/file_write.js";
import { createFileEditTool } from "../../tools/file_edit.js";
import {
  createMemorySaveTool,
  createMemoryAppendTool,
  createMemoryListTool,
  createMemoryReadTool,
  createMemoryDeleteTool,
  createMemoryRestoreTool,
} from "../../tools/memory.js";
import { createSkillUseTool, createSkillListTool } from "../../tools/skill.js";
import { loadConfig } from "../../config.js";
import { appendLog } from "../../workspace/logger.js";
import type { Tool } from "../../types.js";
import { createProfileDeleteTool, createProfileListTool, createProfileReadTool, createProfileSaveTool } from "../../tools/profile.js";

function summarizeArgs(tool: Tool, args: Record<string, unknown>): Record<string, unknown> {
  if (tool.name === "bash") return { command: args.command, timeout: args.timeout, cwd: args.cwd };
  if (tool.name === "file_read") return { path: args.path, offset: args.offset, limit: args.limit };
  if (tool.name === "file_write") return { path: args.path, bytes: typeof args.content === "string" ? Buffer.byteLength(args.content, "utf-8") : undefined };
  if (tool.name === "file_edit") return { path: args.path };
  return { keys: Object.keys(args) };
}

export function withAudit(workspacePath: string, tool: Tool): Tool {
  return {
    ...tool,
    async execute(args, context) {
      const config = loadConfig(workspacePath);
      if (config.security?.auditTools !== false) {
        appendLog(workspacePath, "AUDIT", `工具调用 ${tool.name} ${JSON.stringify(summarizeArgs(tool, args))}`);
      }
      const result = await tool.execute(args, context);
      if (config.security?.auditTools !== false) {
        appendLog(workspacePath, "AUDIT", `工具完成 ${tool.name}`);
      }
      return result;
    },
  };
}

export const coreToolsPlugin: Plugin = {
  name: "core-tools",
  async init(ctx) {
    const getConfig = () => loadConfig(ctx.workspacePath);
    const tools = [
      createWebSearchTool(getConfig),
      createWebFetchTool(),
      createBashTool(ctx.workspacePath, getConfig),
      createFileReadTool(ctx.workspacePath, getConfig),
      createFileWriteTool(ctx.workspacePath, getConfig),
      createFileEditTool(ctx.workspacePath, getConfig),
      createMemorySaveTool(ctx.workspacePath, getConfig),
      createMemoryAppendTool(ctx.workspacePath, getConfig),
      createMemoryListTool(ctx.workspacePath),
      createMemoryReadTool(ctx.workspacePath),
      createMemoryDeleteTool(ctx.workspacePath, getConfig),
      createMemoryRestoreTool(ctx.workspacePath, getConfig),
      createProfileListTool(ctx.workspacePath),
      createProfileReadTool(ctx.workspacePath),
      createProfileSaveTool(ctx.workspacePath, getConfig),
      createProfileDeleteTool(ctx.workspacePath, getConfig),
      createSkillUseTool(ctx.workspacePath, getConfig),
      createSkillListTool(ctx.workspacePath),
    ];
    for (const tool of tools) ctx.registerTool(withAudit(ctx.workspacePath, tool));
  },
};
