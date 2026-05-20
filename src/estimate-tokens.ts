import type { Message } from "./types.js";

/**
 * 估算消息列表的 token 数。
 * 粗略规则：中文约 1 字/token，英文约 1.3 字/token，工具结果按字符数/4。
 * 不追求精确，只用于判断是否接近上下文上限。
 */
export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

function estimateMessageTokens(msg: Message): number {
  if (typeof msg.content === "string") {
    return estimateTextTokens(msg.content) + 4; // role 开销
  }

  let tokens = 4;
  for (const block of msg.content) {
    if (block.type === "text") {
      tokens += estimateTextTokens(block.text);
    } else if (block.type === "tool_use") {
      tokens += estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.input)) + 10;
    } else if (block.type === "tool_result") {
      tokens += estimateTextTokens(block.content) + 6;
    }
  }
  return tokens;
}

function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code > 0x7f) {
      tokens += 1.5; // CJK 等非 ASCII
    } else {
      tokens += 0.25; // ASCII 按单词估算
    }
  }
  return Math.ceil(tokens);
}
