import type {
  ChatResponse,
  Config,
  ContentBlock,
  Message,
  ToolDefinition,
  ToolUseBlock,
  ImageBlock,
} from "../types.js";
import type { ModelClient } from "./types.js";
import { appendLog } from "../workspace/logger.js";
import { sanitizeToolMessageChains } from "../message-sanitizer.js";
import { repairModelRequest } from "./request-repair.js";
import { readImageBlockData } from "../attachments.js";

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

type OpenAIUserContent = Exclude<OpenAIMessage["content"], string | null | undefined>[number];

interface OpenAIToolCallState {
  id?: string;
  name?: string;
  arguments: string;
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

function textFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.type === "text" ? block.text : "")
    .join("");
}

function toOpenAITools(tools?: ToolDefinition[]): Array<{ type: "function"; function: Record<string, unknown> }> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

function toolUseToOpenAIToolCall(block: ToolUseBlock): OpenAIToolCall {
  return {
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      arguments: JSON.stringify(block.input ?? {}),
    },
  };
}

function imageToOpenAIContent(config: Config, block: ImageBlock): {
  type: "image_url";
  image_url: { url: string };
} {
  const data = readImageBlockData(config.workspacePath, block).toString("base64");
  return {
    type: "image_url",
    image_url: { url: `data:${block.source.mediaType};base64,${data}` },
  };
}

function toOpenAIMessages(config: Config, messages: Message[], systemPrompt?: string): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const message of sanitizeToolMessageChains(messages)) {
    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const text = textFromBlocks(message.content);
      const toolCalls = message.content
        .filter((block): block is ToolUseBlock => block.type === "tool_use")
        .map(toolUseToOpenAIToolCall);
      result.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    const userContent: OpenAIUserContent[] = [];
    for (const block of message.content) {
      if (block.type === "text") userContent.push({ type: "text", text: block.text });
      if (block.type === "image") userContent.push(imageToOpenAIContent(config, block));
    }
    if (userContent.length > 0) {
      result.push({ role: "user", content: userContent });
    }
    for (const block of message.content) {
      if (block.type === "tool_result") {
        result.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: block.content,
        });
      }
    }
  }

  return result;
}

export class OpenAIChatClient implements ModelClient {
  private completionTokenParameter: "max_tokens" | "max_completion_tokens" = "max_tokens";

  constructor(private config: Config) {}

  private endpoint(): string {
    const base = this.config.apiUrl.replace(/\/+$/, "");
    if (base.endsWith("/chat/completions")) return base;
    if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  private debugLog(event: string, data: unknown): void {
    if (!modelIODebugEnabled(this.config)) return;
    try {
      appendLog(this.config.workspacePath, "DEBUG", `${event}: ${JSON.stringify(data)}`);
    } catch {
      // Debug logging must never affect model calls.
    }
  }

  private withCompletionTokenLimit(
    body: Record<string, unknown>,
    maxTokens: number,
  ): Record<string, unknown> {
    return {
      ...body,
      [this.completionTokenParameter]: maxTokens,
    };
  }

  private async sendRequest(
    url: string,
    initialBody: Record<string, unknown>,
    mode: "complete" | "chat",
    signal?: AbortSignal,
  ): Promise<Response> {
    let body = initialBody;
    const appliedRepairs = new Set<string>();

    while (true) {
      this.debugLog("model_request", {
        provider: "openai-chat",
        mode,
        url,
        body,
      });

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (response.ok) return response;

      const errorText = await response.text();
      this.debugLog("model_error", {
        provider: "openai-chat",
        mode,
        status: response.status,
        body: errorText,
      });

      const repaired = repairModelRequest({
        provider: "openai-chat",
        model: this.config.model,
        status: response.status,
        errorBody: errorText,
        requestBody: body,
        appliedRepairs,
      });
      if (!repaired) {
        throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
      }

      appliedRepairs.add(repaired.name);
      body = repaired.requestBody;
      if ("max_completion_tokens" in body) {
        this.completionTokenParameter = "max_completion_tokens";
      }
      this.debugLog("model_request_repair", {
        provider: "openai-chat",
        mode,
        repair: repaired.name,
      });
    }
  }

  async complete(messages: Message[], systemPrompt?: string, signal?: AbortSignal): Promise<string> {
    const url = this.endpoint();
    const body = this.withCompletionTokenLimit({
      model: this.config.model,
      messages: toOpenAIMessages(this.config, messages, systemPrompt),
      stream: false,
    }, 1024);

    const response = await this.sendRequest(url, body, "complete", signal);

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    this.debugLog("model_response", {
      provider: "openai-chat",
      mode: "complete",
      status: response.status,
      data,
    });

    return data.choices?.[0]?.message?.content ?? "";
  }

  async chat(
    messages: Message[],
    onDelta: (text: string) => void,
    tools?: ToolDefinition[],
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const url = this.endpoint();
    const openAITools = toOpenAITools(tools);
    let body = this.withCompletionTokenLimit({
      model: this.config.model,
      messages: toOpenAIMessages(this.config, messages, systemPrompt),
      stream: true,
    }, this.config.maxTokens);
    if (openAITools) {
      body.tools = openAITools;
    }

    const response = await this.sendRequest(url, body, "chat", signal);

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
    const toolCallStates = new Map<number, OpenAIToolCallState>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;

      for (const part of parts) {
        const dataLines = part
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6).trim());

        for (const dataLine of dataLines) {
          if (!dataLine || dataLine === "[DONE]") continue;

          try {
            const event = JSON.parse(dataLine) as {
              choices?: Array<{
                delta?: {
                  content?: string | null;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    function?: {
                      name?: string;
                      arguments?: string;
                    };
                  }>;
                };
              }>;
            };
            if (rawStreamDebugEnabled(this.config)) {
              this.debugLog("model_stream_event", event);
            }

            const delta = event.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.content) {
              fullText += delta.content;
              onDelta(delta.content);
            }
            for (const toolCall of delta.tool_calls ?? []) {
              const state = toolCallStates.get(toolCall.index) ?? { arguments: "" };
              if (toolCall.id) state.id = toolCall.id;
              if (toolCall.function?.name) state.name = toolCall.function.name;
              if (toolCall.function?.arguments) state.arguments += toolCall.function.arguments;
              toolCallStates.set(toolCall.index, state);
            }
          } catch {
            // 忽略无法解析的行
          }
        }
      }
    }

    const toolCalls: ToolUseBlock[] = Array.from(toolCallStates.entries())
      .sort(([a], [b]) => a - b)
      .filter(([, state]) => state.id && state.name)
      .map(([, state]) => {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(state.arguments || "{}");
        } catch {}
        return {
          type: "tool_use",
          id: state.id!,
          name: state.name!,
          input,
        };
      });

    const parsed = { text: fullText, toolCalls };
    this.debugLog("model_parsed_response", parsed);
    return parsed;
  }
}

export { OpenAIChatClient as ChatGPTClient };
