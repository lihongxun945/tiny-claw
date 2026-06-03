import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Tool } from "../types.js";

const MAX_READ = 50000;

export function createFileReadTool(workspacePath: string): Tool {
  return {
    name: "file_read",
    description: "读取文件内容，返回带行号的文本。支持按行号范围读取。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径（相对或绝对）",
        },
        offset: {
          type: "number",
          description: "起始行号（从1开始），默认1",
        },
        limit: {
          type: "number",
          description: "读取行数，默认全部",
        },
      },
      required: ["path"],
    },
    execute: async (args) => {
      const filePath = resolve(workspacePath, args.path as string);
      const offset = (args.offset as number) ?? 1;
      const limit = args.limit as number | undefined;

      if (!existsSync(filePath)) {
        return JSON.stringify({ error: `文件不存在: ${filePath}` });
      }

      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        const start = Math.max(1, offset) - 1;
        const end = limit !== undefined ? start + limit : lines.length;
        const selected = lines.slice(start, end);

        const numbered = selected
          .map((line, i) => `${start + i + 1}\t${line}`)
          .join("\n");

        const result = numbered.length > MAX_READ
          ? numbered.slice(0, MAX_READ) + "\n...[内容截断]"
          : numbered;

        return result;
      } catch (err) {
        return JSON.stringify({
          error: `读取失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
