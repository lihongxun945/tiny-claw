import { estimateTextTokens } from "./estimate-tokens.js";
import { getLocalContextSize } from "./model/local-catalog.js";
import type { Config, ToolDefinition } from "./types.js";
import { toolContextOptions } from "./tool-context.js";

export function getEffectiveMaxContextTokens(config: Config): number {
  if (config.remoteModel?.enabled === false && config.localModel?.enabled) {
    return Math.min(
      config.maxContextTokens,
      getLocalContextSize(config.localModel.modelId, config.localModel.contextSize),
    );
  }
  return config.maxContextTokens;
}

export function calculateMessageTokenBudget(
  config: Config,
  systemPrompt: string,
  tools: ToolDefinition[],
): number {
  return Math.floor(calculateHardMessageTokenBudget(config, systemPrompt, tools) * config.contextCompressionThreshold);
}

export function calculateHardMessageTokenBudget(config: Config, systemPrompt: string, tools: ToolDefinition[]): number {
  const max = getEffectiveMaxContextTokens(config);
  const fixed = estimateTextTokens(systemPrompt) + estimateTextTokens(JSON.stringify(tools));
  return Math.max(0, Math.floor(max * (1 - toolContextOptions(config).safetyMargin)) - fixed - config.maxTokens);
}
