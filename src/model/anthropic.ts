import { randomUUID } from "node:crypto";
import type {
  Config,
  Message,
  ToolDefinition,
  ChatResponse,
  ToolUseBlock,
  StreamEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
  ContentBlock,
} from "../types.js";
import type { ModelClient, ModelClientOptions, ModelDebugEvent, ModelDebugPhase } from "./types.js";
import { readImageBlockData } from "../attachments.js";

type AnthropicContentBlock =
  | Exclude<ContentBlock, { type: "image" }>
  | {
    type: "image";
    source: {
      type: "base64";
      media_type: string;
      data: string;
    };
  };

interface AnthropicMessage {
  role: Message["role"];
  content: string | AnthropicContentBlock[];
}

function toAnthropicMessages(config: Config, messages: Message[]): AnthropicMessage[] {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return { role: message.role, content: message.content };
    }
    return {
      role: message.role,
      content: message.content.map((block): AnthropicContentBlock => {
        if (block.type !== "image") return block;
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: block.source.mediaType,
            data: readImageBlockData(config.workspacePath, block).toString("base64"),
          },
        };
      }),
    };
  });
}

function debugEnabled(config: Config): boolean {
  return config.debug === true || (typeof config.debug === "object" && config.debug.enabled === true);
}

function debugObject(config: Config): Exclude<Config["debug"], boolean | undefined> | null {
  return typeof config.debug === "object" ? config.debug : null;
}

function modelIODebugEnabled(config: Config): boolean {
  if (!debugEnabled(config)) return false;
  return config.debug === true || debugObject(config)?.modelIO !== false;
}

function rawStreamDebugEnabled(config: Config): boolean {
  if (!modelIODebugEnabled(config)) return false;
  return config.debug === true || debugObject(config)?.rawStreamEvents !== false;
}

export class AnthropicMessagesClient implements ModelClient {
  constructor(private config: Config, private options: ModelClientOptions = {}) {}

  private endpoint(): string {
    const base = this.config.apiUrl.replace(/\/+$/, "");
    if (base.endsWith("/messages")) return base;
    if (/\/v\d+$/.test(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }

  private debugLog(
    requestId: string,
    mode: "complete" | "chat",
    phase: ModelDebugPhase,
    data: unknown,
  ): void {
    if (!modelIODebugEnabled(this.config)) return;
    try {
      const event: ModelDebugEvent = {
        requestId,
        sessionId: this.options.sessionId,
        timestamp: new Date().toISOString(),
        provider: "anthropic-messages",
        model: this.config.model,
        mode,
        phase,
        data,
      };
      this.options.reportDebug?.(event);
    } catch {
      // Debug logging must never affect model calls.
    }
  }

  /** 非流式调用，用于上下文压缩等内部用途 */
  async complete(messages: Message[], systemPrompt?: string, signal?: AbortSignal): Promise<string> {
    const url = this.endpoint();
    const requestId = randomUUID();

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: 1024,
      messages: toAnthropicMessages(this.config, messages),
      stream: false,
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    this.debugLog(requestId, "complete", "request", {
      attempt: 1,
      url,
      body,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.debugLog(requestId, "complete", "error", {
        attempt: 1,
        status: response.status,
        body: errorText,
      });
      throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };
    this.debugLog(requestId, "complete", "response", {
      status: response.status,
      data,
    });

    return data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }

  async chat(
    messages: Message[],
    onDelta: (text: string) => void,
    tools?: ToolDefinition[],
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const url = this.endpoint();
    const requestId = randomUUID();

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: toAnthropicMessages(this.config, messages),
      stream: true,
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    this.debugLog(requestId, "chat", "request", {
      attempt: 1,
      url,
      body,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.debugLog(requestId, "chat", "error", {
        attempt: 1,
        status: response.status,
        body: errorText,
      });
      throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
    }

    return this.parseSSE(response, onDelta, requestId);
  }

  private async parseSSE(
    response: Response,
    onDelta: (text: string) => void,
    requestId: string,
  ): Promise<ChatResponse> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    // 追踪 content blocks（按 index）
    const blocks: Map<number, { type: string; text?: string; id?: string; name?: string; inputJson?: string }> = new Map();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;

      for (const part of parts) {
        const dataLine = part
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!dataLine) continue;

        const jsonStr = dataLine.slice(6);
        try {
          const event: StreamEvent = JSON.parse(jsonStr);
          if (rawStreamDebugEnabled(this.config)) {
            this.debugLog(requestId, "chat", "stream_event", event);
          }

          if (event.type === "content_block_start") {
            const e = event as ContentBlockStartEvent;
            blocks.set(e.index, {
              type: e.content_block.type,
              text: e.content_block.type === "text" ? (e.content_block as { text: string }).text : undefined,
              id: e.content_block.type === "tool_use" ? (e.content_block as ToolUseBlock).id : undefined,
              name: e.content_block.type === "tool_use" ? (e.content_block as ToolUseBlock).name : undefined,
            });
          }

          if (event.type === "content_block_delta") {
            const e = event as ContentBlockDeltaEvent;
            const delta = e.delta;

            if (delta.type === "text_delta") {
              fullText += delta.text;
              onDelta(delta.text);
            } else if (delta.type === "input_json_delta") {
              const block = blocks.get(e.index);
              if (block) {
                block.inputJson = (block.inputJson ?? "") + delta.partial_json;
              }
            }
            // thinking_delta: 跳过，不输出
          }
        } catch {
          // 忽略无法解析的行
        }
      }
    }

    // 从 blocks 中提取 tool calls
    const toolCalls: ToolUseBlock[] = [];
    for (const [, block] of blocks) {
      if (block.type === "tool_use" && block.id && block.name) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(block.inputJson ?? "{}");
        } catch {}
        toolCalls.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input,
        });
      }
    }

    const parsed = { text: fullText, toolCalls };
    this.debugLog(requestId, "chat", "parsed_response", parsed);
    return parsed;
  }
}

// Backward-compatible name for the original implementation.
export { AnthropicMessagesClient as AnthropicClient };
