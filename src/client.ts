import type { Config, Message, StreamEvent } from "./types.js";

export class AnthropicClient {
  constructor(private config: Config) {}

  async chat(messages: Message[], onDelta: (text: string) => void): Promise<string> {
    const url = `${this.config.apiUrl}/messages`;

    const body = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages,
      stream: true,
    };

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

  private async parseSSE(response: Response, onDelta: (text: string) => void): Promise<string> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

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
          if (event.type === "content_block_delta" && "delta" in event) {
            const delta = event.delta;
            if (delta.type === "text_delta") {
              fullText += delta.text;
              onDelta(delta.text);
            }
          }
        } catch {
          // 忽略无法解析的行
        }
      }
    }

    return fullText;
  }
}
