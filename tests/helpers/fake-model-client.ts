import type { ModelClient } from "../../src/model/index.js";
import type { ChatResponse, Message, ToolDefinition } from "../../src/types.js";

export type ScriptedChat =
  | ChatResponse
  | Error
  | ((messages: Message[], tools?: ToolDefinition[], systemPrompt?: string, signal?: AbortSignal) => ChatResponse | Promise<ChatResponse>);

export class FakeModelClient implements ModelClient {
  readonly calls: Array<{ messages: Message[]; tools?: ToolDefinition[]; systemPrompt?: string }> = [];

  constructor(private scriptedChats: ScriptedChat[]) {}

  async complete(): Promise<string> {
    return "";
  }

  async chat(
    messages: Message[],
    onDelta: (text: string) => void,
    tools?: ToolDefinition[],
    systemPrompt?: string,
    _signal?: AbortSignal,
  ): Promise<ChatResponse> {
    this.calls.push({ messages: [...messages], tools, systemPrompt });
    const scripted = this.scriptedChats.shift();
    if (!scripted) throw new Error("FakeModelClient: 没有剩余的脚本化响应");
    if (scripted instanceof Error) throw scripted;

    const response = typeof scripted === "function"
      ? await scripted(messages, tools, systemPrompt, _signal)
      : scripted;
    if (response.text) onDelta(response.text);
    return response;
  }
}
