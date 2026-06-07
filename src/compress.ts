import type { Message, Config } from "./types.js";
import type { ModelClient } from "./model/index.js";
import { estimateTokens } from "./estimate-tokens.js";

const DEFAULT_CONTEXT_COMPRESSION_MAX_CHARS = 5000;
const DEFAULT_CONTEXT_COMPRESSION_TOOL_RESULT_MAX_CHARS = 500;

function getCompressionMaxChars(config: Config): number {
  const value = config.contextCompressionMaxChars;
  if (!Number.isFinite(value) || value < 100) return DEFAULT_CONTEXT_COMPRESSION_MAX_CHARS;
  return Math.floor(value);
}

function getCompressionToolResultMaxChars(config: Config): number {
  const value = config.contextCompressionToolResultMaxChars;
  if (!Number.isFinite(value) || value < 100) return DEFAULT_CONTEXT_COMPRESSION_TOOL_RESULT_MAX_CHARS;
  return Math.floor(value);
}

function compressPrompt(maxChars: number): string {
  return `请将以下对话历史压缩为一段简洁的摘要，保留关键信息（事实、决策、结论），省略细节和中间过程。用中文输出，不超过 ${maxChars} 字。`;
}

/**
 * 检查是否需要压缩上下文，如果需要则执行压缩。
 * - 压缩 markTurnStart 之前的消息（历史对话）
 * - 如果没有历史可压缩，压缩当前轮早期的工具调用结果
 * 返回压缩后的消息列表。
 */
export async function compressIfNeeded(
  messages: Message[],
  config: Config,
  client: ModelClient,
  turnStartIndex: number,
): Promise<Message[]> {
  const tokens = estimateTokens(messages);
  const threshold = config.maxContextTokens * config.contextCompressionThreshold;

  if (tokens < threshold) return messages;

  const previousMessages = messages.slice(0, turnStartIndex);
  const currentMessages = messages.slice(turnStartIndex);

  // 优先压缩历史对话
  if (previousMessages.length > 2) {
    const compressed = await compressMessages(
      previousMessages,
      client,
      getCompressionMaxChars(config),
      getCompressionToolResultMaxChars(config),
    );
    return [...compressed, ...currentMessages];
  }

  // 历史不足，压缩当前轮前半部分消息
  if (currentMessages.length > 4) {
    const splitIdx = Math.ceil(currentMessages.length / 2);
    const toCompress = currentMessages.slice(0, splitIdx);
    const toKeep = currentMessages.slice(splitIdx);
    const compressed = await compressMessages(
      toCompress,
      client,
      getCompressionMaxChars(config),
      getCompressionToolResultMaxChars(config),
    );
    return [...previousMessages, ...compressed, ...toKeep];
  }

  return messages;
}

async function compressMessages(
  messages: Message[],
  client: ModelClient,
  maxChars: number,
  toolResultMaxChars: number,
): Promise<Message[]> {
  // 将消息格式化为可读文本供模型压缩
  const text = messages
    .map((msg) => {
      if (typeof msg.content === "string") {
        return `[${msg.role}]: ${msg.content}`;
      }
      const parts = msg.content.map((block) => {
        if (block.type === "text") return `[文本]: ${block.text}`;
        if (block.type === "tool_use") return `[工具调用 ${block.name}]: ${JSON.stringify(block.input)}`;
        if (block.type === "tool_result") return `[工具结果]: ${block.content.slice(0, toolResultMaxChars)}`;
        return "";
      });
      return `[${msg.role}]: ${parts.join(" | ")}`;
    })
    .join("\n");

  try {
    const summary = await client.complete(
      [{ role: "user", content: `${compressPrompt(maxChars)}\n\n---\n${text}` }],
      "你是一个对话摘要助手，只输出摘要，不要有任何额外说明。",
    );

    return [
      {
        role: "user",
        content: `[以下是对话历史的摘要]\n${summary}`,
      },
    ];
  } catch {
    // 压缩失败时，简单截断：只保留最后 2 条
    return messages.slice(-2);
  }
}
