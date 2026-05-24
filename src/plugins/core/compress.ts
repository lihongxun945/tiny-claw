import type { Plugin, HookContext } from "../types.js";
import type { Message, Config } from "../../types.js";
import { estimateTokens } from "../../estimate-tokens.js";

const COMPRESS_PROMPT = `请将以下对话历史压缩为一段简洁的摘要，保留关键信息（事实、决策、结论），省略细节和中间过程。用中文输出，不超过 500 字。`;

async function compressMessages(
  messages: Message[],
  ctx: HookContext,
): Promise<Message[]> {
  const text = messages
    .map((msg) => {
      if (typeof msg.content === "string") {
        return `[${msg.role}]: ${msg.content}`;
      }
      const parts = msg.content.map((block) => {
        if (block.type === "text") return `[文本]: ${block.text}`;
        if (block.type === "tool_use") return `[工具调用 ${block.name}]: ${JSON.stringify(block.input)}`;
        if (block.type === "tool_result") return `[工具结果]: ${block.content.slice(0, 500)}`;
        return "";
      });
      return `[${msg.role}]: ${parts.join(" | ")}`;
    })
    .join("\n");

  try {
    const summary = await ctx.client.complete(
      [{ role: "user", content: `${COMPRESS_PROMPT}\n\n---\n${text}` }],
      "你是一个对话摘要助手，只输出摘要，不要有任何额外说明。",
    );

    return [
      {
        role: "user",
        content: `[以下是对话历史的摘要]\n${summary}`,
      },
    ];
  } catch {
    return messages.slice(-2);
  }
}

export const coreCompressPlugin: Plugin = {
  name: "core-compress",
  async init(ctx) {
    const config = ctx.config as unknown as Config;

    ctx.registerHooks({
      onBeforeModelCall: async (hookCtx: HookContext, messages: Message[]) => {
        const tokens = estimateTokens(messages);
        const threshold = config.maxContextTokens * config.contextCompressionThreshold;

        if (tokens < threshold) return messages;

        const turnStartIdx = hookCtx.turnStartIndex;

        // 优先压缩历史对话（turnStartIdx 之前）
        const previousMessages = messages.slice(0, turnStartIdx);
        const currentMessages = messages.slice(turnStartIdx);

        if (previousMessages.length > 2) {
          const compressed = await compressMessages(previousMessages, hookCtx);
          return [...compressed, ...currentMessages];
        }

        // 历史不足，压缩当前轮前半部分
        if (currentMessages.length > 4) {
          const splitIdx = Math.ceil(currentMessages.length / 2);
          const toCompress = currentMessages.slice(0, splitIdx);
          const toKeep = currentMessages.slice(splitIdx);
          const compressed = await compressMessages(toCompress, hookCtx);
          return [...compressed, ...toKeep];
        }

        return messages;
      },
    });
  },
};