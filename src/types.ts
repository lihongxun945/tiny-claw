export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface Config {
  apiUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  historyWindowSize: number;
}

export interface CreateMessageRequest {
  model: string;
  max_tokens: number;
  messages: Message[];
  stream: boolean;
}

export interface TextDelta {
  type: "text_delta";
  text: string;
}

export interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: TextDelta;
}

export type StreamEvent =
  | { type: "message_start" }
  | { type: "content_block_start" }
  | ContentBlockDeltaEvent
  | { type: "content_block_stop" }
  | { type: "message_delta" }
  | { type: "message_stop" };
