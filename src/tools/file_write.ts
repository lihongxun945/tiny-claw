import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Tool } from "../types.js";

export function createFileWriteTool(workspacePath: string): Tool {
  return {
    name: "file_write",
    description: "创建或覆盖写入文件。自动创建不存在的父目录。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径（相对或绝对）",
        },
        content: {
          type: "string",
          description: "要写入的文件内容",
        },
      },
      required: ["path", "content"],
    },
    execute: async (args) => {
      const content = args.content as string;

      try {
        const filePath = resolve(workspacePath, args.path as string);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, content, "utf-8");
        return JSON.stringify({
          path: filePath,
          bytesWritten: Buffer.byteLength(content, "utf-8"),
        });
      } catch (err) {
        return JSON.stringify({
          error: `写入失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
