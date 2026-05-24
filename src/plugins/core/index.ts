import type { Plugin } from "../types.js";
import { coreToolsPlugin } from "./tools.js";
import { corePromptsPlugin } from "./prompts.js";
import { coreCompressPlugin } from "./compress.js";
import { coreLoggerPlugin } from "./logger.js";

export const corePlugins: Plugin[] = [
  coreToolsPlugin,
  corePromptsPlugin,
  coreCompressPlugin,
  coreLoggerPlugin,
];