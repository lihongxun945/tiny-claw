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

export type ModelDebugPhase = "request" | "response" | "parsed_response" | "error" | "repair" | "stream_event";

export interface ModelDebugEvent {
  requestId: string;
  sessionId?: string;
  timestamp: string;
  provider: ModelProvider;
  model: string;
  mode: "chat" | "complete";
  phase: ModelDebugPhase;
  data: unknown;
}

export interface ModelClientOptions {
  sessionId?: string;
  reportDebug?: (event: ModelDebugEvent) => void;
}
