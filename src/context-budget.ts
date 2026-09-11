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
  const maxContextTokens = getEffectiveMaxContextTokens(config);
  const thresholdBudget = Math.floor(maxContextTokens * config.contextCompressionThreshold);
  const fixedTokens = estimateTextTokens(systemPrompt) + estimateTextTokens(JSON.stringify(tools));
  const hardInputBudget = Math.floor(maxContextTokens * (1 - toolContextOptions(config).safetyMargin)) - fixedTokens - config.maxTokens;
  return Math.max(0, Math.min(thresholdBudget - fixedTokens, hardInputBudget));
}

export function calculateHardMessageTokenBudget(config: Config, systemPrompt: string, tools: ToolDefinition[]): number {
  return calculateMessageTokenBudget({ ...config, contextCompressionThreshold: 1 }, systemPrompt, tools);
}
