import type { Config } from "../types.js";
import type { ModelClient, ModelClientOptions, ModelProvider } from "./types.js";
import { AnthropicMessagesClient } from "./anthropic.js";
import { OpenAIChatClient } from "./openai.js";

export function createModelClient(config: Config, options: ModelClientOptions = {}): ModelClient {
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
