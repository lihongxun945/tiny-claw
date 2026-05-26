import type { Config } from "../types.js";
import type { ModelClient, ModelProvider } from "./types.js";
import { AnthropicMessagesClient } from "./anthropic.js";

export function createModelClient(config: Config): ModelClient {
  const provider = (config.modelProvider ?? "anthropic-messages") as ModelProvider;

  switch (provider) {
    case "anthropic-messages":
      return new AnthropicMessagesClient(config);
    default:
      throw new Error(`不支持的模型协议: ${provider}`);
  }
}

export type { ModelClient, ModelProvider } from "./types.js";
export { AnthropicMessagesClient, AnthropicClient } from "./anthropic.js";
