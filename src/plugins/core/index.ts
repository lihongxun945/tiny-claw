import type { Plugin } from "../types.js";
import { coreToolsPlugin } from "./tools.js";
import { coreSubAgentPlugin } from "./sub-agent.js";
import { corePromptsPlugin } from "./prompts.js";
import { coreHistoryPlugin } from "./history.js";
import { coreSessionSummaryPlugin } from "./session-summary.js";
import { coreAutoMemoryPlugin } from "./auto-memory.js";
import { coreCompressPlugin } from "./compress.js";
import { coreLoggerPlugin } from "./logger.js";
import { coreChatCommandsPlugin } from "./chat-commands.js";
import { coreAttachmentsPlugin } from "./attachments.js";
import { coreDebugPlugin } from "./debug.js";
import { coreLocalModelsPlugin } from "./local-models.js";

export const corePlugins: Plugin[] = [
  coreChatCommandsPlugin,
  coreAttachmentsPlugin,
  coreDebugPlugin,
  coreLocalModelsPlugin,
  coreToolsPlugin,
  coreSubAgentPlugin,
  corePromptsPlugin,
  coreHistoryPlugin,
  coreSessionSummaryPlugin,
  coreAutoMemoryPlugin,
  coreCompressPlugin,
  coreLoggerPlugin,
];
