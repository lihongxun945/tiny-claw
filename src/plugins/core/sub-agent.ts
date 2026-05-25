import type { Plugin } from "../types.js";
import { createSubAgentTool } from "../../tools/sub_agent.js";

export const coreSubAgentPlugin: Plugin = {
  name: "core-sub-agent",
  async init(ctx) {
    ctx.registerTool(createSubAgentTool(ctx.workspacePath));
  },
};
