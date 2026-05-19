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

export class AnthropicClient {
  constructor(private config: Config) {}

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

    return { text: fullText, toolCalls };
  }
}
