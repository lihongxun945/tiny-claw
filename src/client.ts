import type {
  Config,
  Message,
  ToolDefinition,
  ChatResponse,
  ToolUseBlock,
  StreamEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
} from "./types.js";
import { appendLog } from "./workspace/logger.js";

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

export class AnthropicClient {
  constructor(private config: Config) {}

  private debugLog(event: string, data: unknown): void {
    if (!modelIODebugEnabled(this.config)) return;
    try {
      appendLog(this.config.workspacePath, "DEBUG", `${event}: ${JSON.stringify(data)}`);
    } catch {
      // Debug logging must never affect model calls.
    }
  }

  /** 非流式调用，用于上下文压缩等内部用途 */
  async complete(messages: Message[], systemPrompt?: string): Promise<string> {
    const url = `${this.config.apiUrl}/v1/messages`;

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: 1024,
      messages,
      stream: false,
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    this.debugLog("model_request", {
      mode: "complete",
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
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.debugLog("model_error", {
        mode: "complete",
        status: response.status,
        body: errorText,
      });
      throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };
    this.debugLog("model_response", {
      mode: "complete",
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
  ): Promise<ChatResponse> {
    const url = `${this.config.apiUrl}/v1/messages`;

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages,
      stream: true,
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    this.debugLog("model_request", {
      mode: "chat",
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
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.debugLog("model_error", {
        mode: "chat",
        status: response.status,
        body: errorText,
      });
      throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
    }

    return this.parseSSE(response, onDelta);
  }

  private async parseSSE(
    response: Response,
    onDelta: (text: string) => void,
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
            this.debugLog("model_stream_event", event);
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
    this.debugLog("model_parsed_response", parsed);
    return parsed;
  }
}
