import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Tool } from "../types.js";

// === 文件操作 ===

const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

function sanitizeName(name: string): string {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`记忆名称只能包含字母、数字、下划线和连字符: ${name}`);
  }
  return name + ".md";
}

function memoryDir(workspacePath: string): string {
  return resolve(workspacePath, "memory");
}

function ensureMemoryDir(workspacePath: string): string {
  const dir = memoryDir(workspacePath);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveMemory(workspacePath: string, name: string, content: string): string {
  const dir = ensureMemoryDir(workspacePath);
  const filePath = resolve(dir, sanitizeName(name));
  writeFileSync(filePath, content.trim() + "\n", "utf-8");
  return `已保存记忆: ${name}`;
}

export function appendMemory(workspacePath: string, name: string, content: string): string {
  const dir = ensureMemoryDir(workspacePath);
  const filePath = resolve(dir, sanitizeName(name));
  appendFileSync(filePath, content.trim() + "\n", "utf-8");
  return `已追加记忆: ${name}`;
}

export function listMemories(workspacePath: string): string {
  const dir = memoryDir(workspacePath);

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return "暂无记忆";
  }

  if (files.length === 0) return "暂无记忆";

  const entries: string[] = [];
  for (const file of files) {
    const name = file.replace(/\.md$/, "");
    const content = readFileSync(resolve(dir, file), "utf-8").trim();
    entries.push(`[${name}]\n${content}`);
  }

  return entries.join("\n\n");
}

export function loadAllMemories(workspacePath: string): string {
  const dir = memoryDir(workspacePath);

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return "";
  }

  const parts: string[] = [];
  for (const file of files) {
    const name = file.replace(/\.md$/, "");
    const content = readFileSync(resolve(dir, file), "utf-8").trim();
    if (content) {
      parts.push(`# ${name}\n${content}`);
    }
  }

  return parts.join("\n\n");
}

// === 工具定义 ===

export function createMemorySaveTool(workspacePath: string): Tool {
  return {
    name: "memory_save",
    description: "保存或覆盖一条长期记忆。当用户明确告诉你需要记住的信息时（偏好、约定、事实等），用此工具记录下来。name 是文件名（不含 .md），content 是记忆内容",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "记忆名称，只能包含字母、数字、下划线、连字符",
        },
        content: {
          type: "string",
          description: "记忆内容，markdown 格式",
        },
      },
      required: ["name", "content"],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const name = String(args.name ?? "");
      const content = String(args.content ?? "");
      return saveMemory(workspacePath, name, content);
    },
  };
}

export function createMemoryAppendTool(workspacePath: string): Tool {
  return {
    name: "memory_append",
    description: "追加内容到已有的长期记忆文件。当有新的信息需要补充到已保存的记忆中时使用，如果文件不存在会创建",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "记忆名称，只能包含字母、数字、下划线、连字符",
        },
        content: {
          type: "string",
          description: "要追加的内容，markdown 格式",
        },
      },
      required: ["name", "content"],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const name = String(args.name ?? "");
      const content = String(args.content ?? "");
      return appendMemory(workspacePath, name, content);
    },
  };
}

export function createMemoryListTool(workspacePath: string): Tool {
  return {
    name: "memory_list",
    description: "列出所有长期记忆的内容。当用户询问你记住了什么、或者你想回顾之前记忆的信息时使用",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    execute: async (): Promise<string> => {
      return listMemories(workspacePath);
    },
  };
}