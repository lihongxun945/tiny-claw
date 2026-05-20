import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadAllMemories } from "./memory.js";

const SUBDIRS = ["skills", "memory", "history", "logs"];

export function resolveWorkspacePath(cliPath?: string): string {
  return cliPath || process.env.TINY_CLAW_WORKSPACE || resolve(process.cwd(), "workspace");
}

export function ensureWorkspace(workspacePath: string): void {
  for (const dir of SUBDIRS) {
    mkdirSync(resolve(workspacePath, dir), { recursive: true });
  }
}

export function loadIdentity(workspacePath: string): string {
  try {
    return readFileSync(resolve(workspacePath, "identity.md"), "utf-8");
  } catch {
    return "";
  }
}

export function buildSystemPrompt(workspacePath: string): string {
  const identity = loadIdentity(workspacePath);

  const parts = [
    "你是一个自主 AI Agent，名为 tiny-claw。你可以使用各种工具来帮助用户完成任务。",
    "请根据用户的指令自主规划并执行任务，在需要时调用合适的工具。",
    "每次执行工具后，基于结果决定下一步行动或给出最终回答。",
  ];

  if (identity) {
    parts.push("\n## 身份设定\n");
    parts.push(identity);
  }

  const memories = loadAllMemories(workspacePath);
  if (memories) {
    parts.push("\n## 长期记忆\n");
    parts.push("以下是你在之前的对话中记住的信息：");
    parts.push(memories);
  }

  return parts.join("\n");
}