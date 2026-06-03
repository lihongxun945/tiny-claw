import type { ChatResponse, Message, ToolDefinition } from "../types.js";

export interface ModelClient {
  complete(messages: Message[], systemPrompt?: string, signal?: AbortSignal): Promise<string>;
  chat(
    messages: Message[],
    onDelta: (text: string) => void,
    tools?: ToolDefinition[],
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<ChatResponse>;
}

export type ModelProvider = "anthropic-messages" | "openai-chat" | "chatgpt";
