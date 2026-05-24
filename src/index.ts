import * as readline from "node:readline/promises";
import { resolve } from "node:path";
import { AgentSession } from "./agent.js";
import { PluginManager } from "./plugin-manager.js";
import { resolveWorkspacePath } from "./workspace/workspace.js";

function parseWorkspaceArg(): string | undefined {
  const idx = process.argv.indexOf("--workspace");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

async function main() {
  const workspacePath = resolveWorkspacePath(parseWorkspaceArg());
  const pm = new PluginManager(workspacePath);
  await pm.loadCorePlugins();
  const session = new AgentSession("cli", workspacePath, pm);
  console.log(`工作目录: ${workspacePath}\n`);

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

    process.stdout.write("Assistant: ");

    for await (const event of session.chat(userInput)) {
      switch (event.type) {
        case "text_delta":
          process.stdout.write(event.text);
          break;
        case "tool_call":
          process.stdout.write(`\n[工具调用] ${event.name}(${JSON.stringify(event.input)})\n`);
          break;
        case "tool_result":
          process.stdout.write(`[工具结果] ${event.result.slice(0, 200)}${event.result.length > 200 ? "..." : ""}\n`);
          break;
        case "error":
          process.stdout.write(`\n错误: ${event.message}\n`);
          break;
        case "done":
          process.stdout.write("\n\n");
          break;
      }
    }
  }
}

main();
