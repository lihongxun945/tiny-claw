import type { Message } from "./types.js";

export class MessageHistory {
  private messages: Message[] = [];

  push(message: Message): void {
    this.messages.push(message);
  }

  getRecentMessages(windowSize: number): Message[] {
    const maxMessages = windowSize * 2;
    let result = this.messages.slice(-maxMessages);

    // 保证第一条是 user 消息，满足 API 交替约束
    if (result.length > 0 && result[0].role === "assistant") {
      result = result.slice(1);
    }

    return result;
  }
}
