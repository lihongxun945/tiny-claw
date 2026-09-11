import type { Plugin } from "../types.js";
import { coreToolsPlugin } from "./tools.js";
import { coreBackgroundPlugin } from "./background.js";
import { coreSubAgentPlugin } from "./sub-agent.js";
import { corePromptsPlugin } from "./prompts.js";
import { coreHistoryPlugin } from "./history.js";
import { coreSessionSummaryPlugin } from "./session-summary.js";
import { coreSessionRecallPlugin } from "./session-recall.js";
import { coreAutoMemoryPlugin } from "./auto-memory.js";
import { coreLoggerPlugin } from "./logger.js";
import { coreChatCommandsPlugin } from "./chat-commands.js";
import { coreAttachmentsPlugin } from "./attachments.js";
import { coreDebugPlugin } from "./debug.js";
import { coreLocalModelsPlugin } from "./local-models.js";
import { coreProjectPlugin } from "./project.js";
import { coreProjectToolsPlugin } from "./project-tools.js";
import { corePlanPlugin } from "./plan.js";
import { coreUserInputPlugin } from "./user-input.js";
import { coreVectorMemoryPlugin } from "./vector-memory.js";
import { coreProfileMemoryPlugin } from "./profile-memory.js";
import { coreContextInspectorPlugin } from "./context-inspector.js";
import { coreToolContextPlugin } from "./tool-context.js";

export const corePlugins: Plugin[] = [
  coreChatCommandsPlugin,
  coreAttachmentsPlugin,
  coreDebugPlugin,
  coreContextInspectorPlugin,
  coreLocalModelsPlugin,
  coreToolsPlugin,
  coreBackgroundPlugin,
  coreProfileMemoryPlugin,
  coreVectorMemoryPlugin,
  coreSubAgentPlugin,
  corePromptsPlugin,
  coreProjectPlugin,
  coreProjectToolsPlugin,
  corePlanPlugin,
  coreUserInputPlugin,
  coreHistoryPlugin,
  coreSessionSummaryPlugin,
  coreToolContextPlugin,
  coreSessionRecallPlugin,
  coreAutoMemoryPlugin,
  coreLoggerPlugin,
];
