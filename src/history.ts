import type { Message } from "./types.js";

export class MessageHistory {
  private messages: Message[] = [];
  private currentTurnStart: number = 0;

  /** 标记新一轮用户对话的开始（当前 Agent Loop 的消息不应被截断） */
  markTurnStart(): void {
    this.currentTurnStart = this.messages.length;
  }

  push(message: Message): void {
    this.messages.push(message);
  }

  getRecentMessages(windowSize: number): Message[] {
    // 当前 Agent Loop 的消息全部保留，不参与截断
    const currentTurn = this.messages.slice(this.currentTurnStart);

    // 之前的消息按窗口截取
    const previousMessages = this.messages.slice(0, this.currentTurnStart);
    const maxPrevious = windowSize * 2;
    let trimmed = previousMessages.slice(-maxPrevious);

    // 保证第一条是 user 消息，满足 API 交替约束
    if (trimmed.length > 0 && trimmed[0].role === "assistant") {
      trimmed = trimmed.slice(1);
    }

    return [...trimmed, ...currentTurn];
  }
}
