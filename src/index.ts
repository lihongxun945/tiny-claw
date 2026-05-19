import * as readline from "node:readline/promises";
import { loadConfig } from "./config.js";
import { AnthropicClient } from "./client.js";
import { MessageHistory } from "./history.js";

async function main() {
  const config = loadConfig();
  const client = new AnthropicClient(config);
  const history = new MessageHistory();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let stdinClosed = false;
  rl.on("close", () => {
    stdinClosed = true;
  });

  console.log("tiny-claw 已启动，输入问题开始对话 (Ctrl+C 退出)\n");

  while (!stdinClosed) {
    let userInput: string;
    try {
      userInput = await rl.question("You: ");
    } catch {
      break;
    }
    if (!userInput.trim()) continue;

    history.push({ role: "user", content: userInput });
    const context = history.getRecentMessages(config.historyWindowSize);

    process.stdout.write("Assistant: ");
    try {
      const response = await client.chat(context, (delta) => {
        process.stdout.write(delta);
      });
      process.stdout.write("\n\n");
      history.push({ role: "assistant", content: response });
    } catch (err) {
      process.stdout.write("\n");
      console.error("错误:", err instanceof Error ? err.message : err);
    }
  }
}

main();
