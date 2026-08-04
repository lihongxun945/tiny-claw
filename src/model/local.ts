import type { LlamaModel } from "node-llama-cpp";
import type { ChatResponse, Config, ContentBlock, Message, ToolDefinition, ToolUseBlock } from "../types.js";
import type { ModelClient, ModelClientOptions, ModelDebugEvent, ModelDebugPhase, CompleteOptions } from "./types.js";
import { getLocalModelPath } from "./local-store.js";
import { getLocalContextSize } from "./local-catalog.js";

const loadedModels = new Map<string, Promise<LlamaModel>>();

class LocalToolCallBoundary extends Error {
  constructor() {
    super("Local model tool call captured");
    this.name = "LocalToolCallBoundary";
  }
}

function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "image") return `[图片: ${block.name}]`;
    if (block.type === "tool_use") return `[工具调用 ${block.name}] ${JSON.stringify(block.input)}`;
    return `[工具结果 ${block.tool_use_id}] ${block.content}`;
  }).join("\n");
}

function historyPrompt(messages: Message[]): string {
  return messages.map((message) => `${message.role === "user" ? "用户" : "助手"}: ${contentToText(message.content)}`).join("\n\n");
}

async function loadModel(path: string) {
  let pending = loadedModels.get(path);
  if (!pending) {
    pending = import("node-llama-cpp").then(async ({ getLlama }) => {
      const llama = await getLlama({ gpu: "auto" });
      return llama.loadModel({ modelPath: path });
    });
    loadedModels.set(path, pending);
  }
  return pending;
}

function modelIODebugEnabled(config: Config): boolean {
  if (config.debug === true) return true;
  return typeof config.debug === "object"
    && config.debug.enabled === true
    && config.debug.modelIO !== false;
}

export class LocalLlamaClient implements ModelClient {
  constructor(private readonly config: Config, private readonly options: ModelClientOptions = {}) {}

  private debugLog(
    requestId: string,
    mode: "complete" | "chat",
    phase: ModelDebugPhase,
    data: unknown,
    modelId: string,
  ): void {
    if (!modelIODebugEnabled(this.config)) return;
    try {
      const event: ModelDebugEvent = {
        requestId,
        sessionId: this.options.sessionId,
        timestamp: new Date().toISOString(),
        provider: "local-llama",
        model: modelId,
        mode,
        phase,
        data,
      };
      this.options.reportDebug?.(event);
    } catch {
      // Debug logging must never affect model calls.
    }
  }

  private async run(
    messages: Message[],
    onDelta: (text: string) => void,
    tools: ToolDefinition[] = [],
    systemPrompt = "",
    signal?: AbortSignal,
    mode: "complete" | "chat" = "chat",
    maxTokens?: number,
  ): Promise<ChatResponse> {
    const modelId = this.config.localModel?.modelId ?? "qwen3.5-4b-q4";
    const requestId = crypto.randomUUID();
    const contextSize = getLocalContextSize(modelId, this.config.localModel?.contextSize);
    const effectiveMaxTokens = maxTokens ?? this.config.maxTokens;
    this.debugLog(requestId, mode, "request", {
      model: modelId,
      contextSize,
      maxTokens: effectiveMaxTokens,
      systemPrompt,
      messages,
      tools,
    }, modelId);

    try {
      const modelPath = getLocalModelPath(this.config.workspacePath, modelId);
      if (!modelPath) throw new Error(`本地模型 ${modelId} 尚未下载，请先在设置页面下载`);
      const model = await loadModel(modelPath);
      const { LlamaChatSession, defineChatSessionFunction } = await import("node-llama-cpp");
      const context = await model.createContext({ contextSize });
      const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt });
      const toolCalls: ToolUseBlock[] = [];
      let streamedText = "";
      const functions = Object.fromEntries(tools.map((tool) => [
        tool.name,
        defineChatSessionFunction({
          description: tool.description,
          params: tool.input_schema as never,
          handler: (input: unknown) => {
            toolCalls.push({
              type: "tool_use",
              id: `local_${crypto.randomUUID()}`,
              name: tool.name,
              input: input as Record<string, unknown>,
            });
            throw new LocalToolCallBoundary();
          },
        }),
      ]));
      try {
        let response: ChatResponse;
        try {
          const result = await session.promptWithMeta(historyPrompt(messages), {
            functions: tools.length > 0 ? functions : undefined,
            maxTokens: effectiveMaxTokens,
            signal,
            onTextChunk: (text) => {
              streamedText += text;
              onDelta(text);
            },
          });
          response = { text: result.responseText, toolCalls };
        } catch (error) {
          if (error instanceof LocalToolCallBoundary && toolCalls.length > 0) {
            response = { text: streamedText, toolCalls };
          } else {
            throw error;
          }
        }
        this.debugLog(requestId, mode, "parsed_response", response, modelId);
        return response;
      } finally {
        session.dispose();
        context.dispose();
      }
    } catch (error) {
      this.debugLog(requestId, mode, "error", {
        message: error instanceof Error ? error.message : String(error),
      }, modelId);
      throw error;
    }
  }

  async complete(messages: Message[], systemPrompt?: string, options?: CompleteOptions): Promise<string> {
    return (await this.run(messages, () => {}, [], systemPrompt, options?.signal, "complete")).text;
  }

  chat(messages: Message[], onDelta: (text: string) => void, tools?: ToolDefinition[], systemPrompt?: string, signal?: AbortSignal) {
    return this.run(messages, onDelta, tools, systemPrompt, signal);
  }
}
