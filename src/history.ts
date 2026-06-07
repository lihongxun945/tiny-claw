import type { Message } from "./types.js";
import { sanitizeToolMessageChains, stripToolMessagesForNewTurn } from "./message-sanitizer.js";

export class MessageHistory {
  private messages: Message[] = [];
  private currentTurnStart: number = 0;

  constructor(initialMessages: Message[] = []) {
    this.messages = [...initialMessages];
    this.currentTurnStart = this.messages.length;
  }

  /** 标记新一轮用户对话的开始（当前 Agent Loop 的消息不应被截断） */
  markTurnStart(): void {
    this.currentTurnStart = this.messages.length;
  }

  push(message: Message): void {
    this.messages.push(message);
  }

  getRecentMessages(windowSize: number): Message[] {
    return this._buildContext(windowSize).messages;
  }

  getCurrentTurnMessages(): Message[] {
    return this.messages.slice(this.currentTurnStart);
  }

  /** 返回上下文消息中当前轮消息的起始索引 */
  getTurnStartIndexInContext(windowSize: number): number {
    return this._buildContext(windowSize).turnStartIndex;
  }

  /** 压缩后替换内部消息列表 */
  replaceWithCompressed(messages: Message[], newTurnStart: number): void {
    this.messages = [...messages];
    this.currentTurnStart = newTurnStart;
  }

  private _buildContext(windowSize: number): { messages: Message[]; turnStartIndex: number } {
    const currentTurn = this.messages.slice(this.currentTurnStart);
    const previousMessages = this.messages.slice(0, this.currentTurnStart);
    const maxPrevious = windowSize * 2;
    let trimmed = maxPrevious > 0 ? previousMessages.slice(-maxPrevious) : [];

    if (trimmed.length > 0 && trimmed[0].role === "assistant") {
      trimmed = trimmed.slice(1);
    }

    const sanitizedPrevious = stripToolMessagesForNewTurn(trimmed);
    const sanitizedCurrentTurn = sanitizeToolMessageChains(currentTurn);

    return {
      messages: [...sanitizedPrevious, ...sanitizedCurrentTurn],
      turnStartIndex: sanitizedPrevious.length,
    };
  }
}
