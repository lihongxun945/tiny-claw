import type { Plugin } from "../types.js";
import { coreToolsPlugin } from "./tools.js";
import { coreSubAgentPlugin } from "./sub-agent.js";
import { corePromptsPlugin } from "./prompts.js";
import { coreSessionSummaryPlugin } from "./session-summary.js";
import { coreCompressPlugin } from "./compress.js";
import { coreLoggerPlugin } from "./logger.js";

export const corePlugins: Plugin[] = [
  coreToolsPlugin,
  coreSubAgentPlugin,
  corePromptsPlugin,
  coreSessionSummaryPlugin,
  coreCompressPlugin,
  coreLoggerPlugin,
];
