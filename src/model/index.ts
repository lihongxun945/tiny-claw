import type { Config, ModelProfile } from "../types.js";
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

export function createModelClientFromProfile(
  profile: ModelProfile,
  config: Config,
  options: ModelClientOptions = {},
): ModelClient {
  return createModelClient({
    ...config,
    apiUrl: profile.apiUrl ?? config.apiUrl,
    apiKey: profile.apiKey ?? config.apiKey,
    model: profile.model ?? config.model,
    modelProvider: profile.provider,
    remoteModel: { enabled: profile.provider !== "local-llama" },
    localModel: profile.provider === "local-llama"
      ? { enabled: true, modelId: profile.localModelId, contextSize: profile.contextSize }
      : { enabled: false },
    maxTokens: profile.maxTokens ?? config.maxTokens,
  }, options);
}

export type { ModelClient, ModelClientOptions, ModelDebugEvent, ModelDebugPhase, ModelProvider } from "./types.js";
export { AnthropicMessagesClient, AnthropicClient } from "./anthropic.js";
export { OpenAIChatClient, ChatGPTClient } from "./openai.js";
export { LocalLlamaClient } from "./local.js";
