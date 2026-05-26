import type { ChatResponse, Message, ToolDefinition } from "../types.js";

export interface ModelClient {
  complete(messages: Message[], systemPrompt?: string): Promise<string>;
  chat(
    messages: Message[],
    onDelta: (text: string) => void,
    tools?: ToolDefinition[],
    systemPrompt?: string,
  ): Promise<ChatResponse>;
}

export type ModelProvider = "anthropic-messages";
