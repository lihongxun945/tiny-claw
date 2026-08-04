import type { Config } from "../types.js";
import type { ModelClient, ModelClientOptions, ModelProvider } from "./types.js";
import { AnthropicMessagesClient } from "./anthropic.js";
import { OpenAIChatClient } from "./openai.js";
import { LocalLlamaClient } from "./local.js";

export function createModelClient(config: Config, options: ModelClientOptions = {}): ModelClient {
  if (config.remoteModel?.enabled === false) {
    if (config.localModel?.enabled) return new LocalLlamaClient(config, options);
    throw new Error("远程模型和本地模型均未启用");
  }
  const provider = (config.modelProvider ?? "anthropic-messages") as ModelProvider;

  switch (provider) {
    case "anthropic-messages":
      return new AnthropicMessagesClient(config, options);
    case "openai-chat":
    case "chatgpt":
      return new OpenAIChatClient(config, options);
    default:
      throw new Error(`不支持的模型协议: ${provider}`);
  }
}

export type { ModelClient, ModelClientOptions, ModelDebugEvent, ModelDebugPhase, ModelProvider } from "./types.js";
export { AnthropicMessagesClient, AnthropicClient } from "./anthropic.js";
export { OpenAIChatClient, ChatGPTClient } from "./openai.js";
export { LocalLlamaClient } from "./local.js";
