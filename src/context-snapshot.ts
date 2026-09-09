import { getEffectiveMaxContextTokens } from "./context-budget.js";
import { estimateTextTokens, estimateTokens } from "./estimate-tokens.js";
import type { Config, Message, ToolDefinition } from "./types.js";
import type { ContextTokenUsage, PreparedModelRequest } from "./plugins/types.js";

function cleanMessages(messages: Message[]): Message[] {
  return messages.map(({ _turnId, _messageId, _sequence, ...message }) => ({
    ...message,
    content: typeof message.content === "string"
      ? message.content
      : message.content.map((block) => block.type === "image"
        ? { ...block, source: { ...block.source, path: "[attachment]" } }
        : block),
  }));
}

export function calculateContextTokenUsage(
  config: Config,
  systemPrompt: string,
  messages: Message[],
  tools: ToolDefinition[],
): ContextTokenUsage {
  const maxContext = getEffectiveMaxContextTokens(config);
  const systemPromptTokens = estimateTextTokens(systemPrompt);
  const messageTokens = estimateTokens(messages);
  const toolTokens = tools.length > 0 ? estimateTextTokens(JSON.stringify(tools)) : 0;
  const input = systemPromptTokens + messageTokens + toolTokens;
  const totalReserved = input + config.maxTokens;
  return {
    systemPrompt: systemPromptTokens,
    messages: messageTokens,
    tools: toolTokens,
    outputReserved: config.maxTokens,
    input,
    totalReserved,
    maxContext,
    percent: maxContext > 0 ? Math.min(100, Math.round((input / maxContext) * 100)) : 0,
  };
}

export function createPreparedModelRequest(options: {
  contextSummaries?: PreparedModelRequest["contextSummaries"];
  config: Config;
  sessionId: string;
  turnId?: string;
  iteration: number;
  attempt: number;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
}): PreparedModelRequest {
  const messages = cleanMessages(options.messages);
  return {
    sessionId: options.sessionId,
    contextSummaries: (options.contextSummaries ?? []).map((section) => ({ ...section })),
    turnId: options.turnId,
    iteration: options.iteration,
    attempt: options.attempt,
    createdAt: new Date().toISOString(),
    systemPrompt: options.systemPrompt,
    messages,
    tools: options.tools,
    usage: calculateContextTokenUsage(options.config, options.systemPrompt, messages, options.tools),
  };
}
