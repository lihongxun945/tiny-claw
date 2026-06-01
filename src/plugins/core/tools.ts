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
  createMemorySearchTool,
  createMemoryDeleteTool,
} from "../../tools/memory.js";
import { createSkillUseTool, createSkillListTool } from "../../tools/skill.js";
import { loadConfig } from "../../config.js";

export const coreToolsPlugin: Plugin = {
  name: "core-tools",
  async init(ctx) {
    ctx.registerTool(createWebSearchTool(() => loadConfig(ctx.workspacePath)));
    ctx.registerTool(createWebFetchTool());
    ctx.registerTool(createBashTool());
    ctx.registerTool(createFileReadTool());
    ctx.registerTool(createFileWriteTool());
    ctx.registerTool(createFileEditTool());
    ctx.registerTool(createMemorySaveTool(ctx.workspacePath));
    ctx.registerTool(createMemoryAppendTool(ctx.workspacePath));
    ctx.registerTool(createMemoryListTool(ctx.workspacePath));
    ctx.registerTool(createMemoryReadTool(ctx.workspacePath));
    ctx.registerTool(createMemorySearchTool(ctx.workspacePath));
    ctx.registerTool(createMemoryDeleteTool(ctx.workspacePath));
    ctx.registerTool(createSkillUseTool(ctx.workspacePath));
    ctx.registerTool(createSkillListTool(ctx.workspacePath));
  },
};
