import { AgentSession } from "../../agent.js";
import { FeishuClient } from "./client.js";

export async function processFeishuMessage(
  session: AgentSession,
  userText: string,
  messageId: string,
  client: FeishuClient,
): Promise<void> {
  let fullText = "";

  for await (const event of session.chat(userText)) {
    switch (event.type) {
      case "text_delta":
        fullText += event.text;
        break;
      case "tool_call":
        fullText += `\n[工具调用] ${event.name}(${JSON.stringify(event.input).slice(0, 200)})\n`;
        break;
      case "tool_result":
        fullText += `\n[工具结果] ${event.result.slice(0, 500)}\n`;
        break;
      case "error":
        fullText += `\n错误: ${event.message}`;
        break;
      case "done":
        break;
    }
  }

  if (fullText.trim()) {
    await client.replyMessage(messageId, fullText);
  }
}
