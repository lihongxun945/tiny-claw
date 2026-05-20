import * as readline from "node:readline/promises";
import { loadConfig } from "./config.js";
import { AnthropicClient } from "./client.js";
import { MessageHistory } from "./history.js";
import { ToolRegistry } from "./tools/registry.js";
import { createWebSearchTool } from "./tools/search.js";
import { createBashTool } from "./tools/bash.js";
import { createFileReadTool } from "./tools/file_read.js";
import { createFileWriteTool } from "./tools/file_write.js";
import { createFileEditTool } from "./tools/file_edit.js";
import { resolveWorkspacePath, ensureWorkspace, buildSystemPrompt } from "./workspace/workspace.js";
import { createMemorySaveTool, createMemoryAppendTool, createMemoryListTool } from "./tools/memory.js";
import { appendHistory, appendLog } from "./workspace/logger.js";
import type { Message, ToolUseBlock, ToolResultBlock } from "./types.js";

function parseWorkspaceArg(): string | undefined {
  const idx = process.argv.indexOf("--workspace");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

async function main() {
  const workspacePath = resolveWorkspacePath(parseWorkspaceArg());
  ensureWorkspace(workspacePath);
  console.log(`工作目录: ${workspacePath}\n`);

  const config = loadConfig(workspacePath);
  const client = new AnthropicClient(config);
  const history = new MessageHistory();
  const systemPrompt = buildSystemPrompt(workspacePath);

  const registry = new ToolRegistry();
  registry.register(createWebSearchTool());
  registry.register(createBashTool());
  registry.register(createFileReadTool());
  registry.register(createFileWriteTool());
  registry.register(createFileEditTool());
  registry.register(createMemorySaveTool(workspacePath));
  registry.register(createMemoryAppendTool(workspacePath));
  registry.register(createMemoryListTool(workspacePath));

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

    const userMsg: Message = { role: "user", content: userInput };
    appendHistory(workspacePath, userMsg);
    appendLog(workspacePath, "INFO", `用户输入: ${userInput}`);
    history.markTurnStart();
    history.push(userMsg);

    // Agent loop: 模型输出 → 可能调用工具 → 执行工具 → 结果反馈给模型 → 循环
    const maxIterations = config.maxAgentIterations > 0 ? config.maxAgentIterations : Infinity;
    let agentIteration = 0;

    while (!stdinClosed && agentIteration < maxIterations) {
      agentIteration++;
      const context = history.getRecentMessages(config.historyWindowSize);
      const toolDefs = registry.getDefinitions();

      process.stdout.write("Assistant: ");
      let response;
      try {
        response = await client.chat(
          context,
          (delta) => process.stdout.write(delta),
          toolDefs.length > 0 ? toolDefs : undefined,
          systemPrompt,
        );
      } catch (err) {
        process.stdout.write("\n");
        const errMsg = err instanceof Error ? err.message : String(err);
        appendLog(workspacePath, "ERROR", `API 请求失败: ${errMsg}`);
        console.error("错误:", errMsg);
        break;
      }
      process.stdout.write("\n");

      // 构造 assistant 消息的 content blocks
      const assistantContent: (ToolUseBlock | { type: "text"; text: string })[] = [];
      if (response.text) {
        assistantContent.push({ type: "text", text: response.text });
      }
      for (const tc of response.toolCalls) {
        assistantContent.push(tc);
      }

      if (assistantContent.length > 0) {
        const assistantMsg: Message = { role: "assistant", content: assistantContent };
        appendHistory(workspacePath, assistantMsg);
        if (response.text) {
          appendLog(workspacePath, "INFO", `Assistant: ${response.text.slice(0, 200)}`);
        }
        history.push(assistantMsg);
      }

      // 无工具调用，结束 agent loop，等待用户输入
      if (response.toolCalls.length === 0) {
        break;
      }

      // 执行工具调用，将结果加入历史
      for (const toolCall of response.toolCalls) {
        console.log(`[工具调用] ${toolCall.name}(${JSON.stringify(toolCall.input)})`);
        appendLog(workspacePath, "TOOL", `调用: ${toolCall.name}(${JSON.stringify(toolCall.input)})`);

        const tool = registry.getTool(toolCall.name);
        let result: string;
        if (tool) {
          try {
            result = await tool.execute(toolCall.input);
            console.log(`[工具结果] ${result.slice(0, 200)}${result.length > 200 ? "..." : ""}`);
            appendLog(workspacePath, "TOOL", `结果: ${result.slice(0, 500)}`);
          } catch (err) {
            result = JSON.stringify({
              error: `工具执行失败: ${err instanceof Error ? err.message : String(err)}`,
            });
            appendLog(workspacePath, "ERROR", `工具执行失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          result = JSON.stringify({ error: `未知工具: ${toolCall.name}` });
          appendLog(workspacePath, "ERROR", `未知工具: ${toolCall.name}`);
        }

        const toolResult: ToolResultBlock = {
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: result,
        };
        const toolResultMsg: Message = { role: "user", content: [toolResult] };
        appendHistory(workspacePath, toolResultMsg);
        history.push(toolResultMsg);
      }

      // 继续循环，让模型基于工具结果继续输出
    }

    if (config.maxAgentIterations > 0 && agentIteration >= maxIterations) {
      console.log("[达到最大迭代次数，强制结束本轮任务]");
      appendLog(workspacePath, "WARN", "Agent Loop 达到最大迭代次数限制");
    }

    console.log("");
  }
}

main();