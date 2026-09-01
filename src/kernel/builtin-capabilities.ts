import type { Tool } from "../types.js";
import type { ChatCommand, PluginHooks, PromptSection, RegisteredRoute } from "../plugins/types.js";
import { multiCapability } from "./capability.js";

export const TOOL_CAPABILITY = multiCapability<Tool>("agent.tools");
export const CHAT_COMMAND_CAPABILITY = multiCapability<ChatCommand>("chat.commands");
export const ROUTE_CAPABILITY = multiCapability<RegisteredRoute>("gateway.routes");
export const PROMPT_SECTION_CAPABILITY = multiCapability<PromptSection>("prompt.sections");
export const PLUGIN_HOOKS_CAPABILITY = multiCapability<PluginHooks>("plugin.hooks");
