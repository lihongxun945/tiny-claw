import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Config, Tool } from "../types.js";
import { checkDangerousToolPermission } from "./permission.js";
import { resolveRootFile } from "./workspace-path.js";

export function createFileEditTool(workspacePath: string, getConfig: () => Config): Tool {
  return {
    name: "file_edit",
    description:
      "精确替换文件中的文本片段。old_text 必须在文件中唯一匹配。用于修改已有文件，而非重写整个文件。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径（相对或绝对）",
        },
        old_text: {
          type: "string",
          description: "要替换的原始文本（必须唯一匹配）",
        },
        new_text: {
          type: "string",
          description: "替换后的新文本",
        },
      },
      required: ["path", "old_text", "new_text"],
    },
    execute: async (args, context) => {
      const root = context?.rootPath ?? workspacePath;
      let filePath: string;
      try {
        filePath = context?.restrictToRoot
          ? resolveRootFile(root, args.path as string)
          : resolve(root, args.path as string);
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
      const oldText = args.old_text as string;
      const newText = args.new_text as string;

      if (!existsSync(filePath)) {
        return JSON.stringify({ error: `文件不存在: ${filePath}` });
      }

      try {
        const permission = checkDangerousToolPermission({
          workspacePath,
          config: context?.config ?? getConfig(),
          toolName: "file_edit",
          args,
          context,
          command: `edit ${filePath}`,
          cwd: dirname(filePath),
        });
        if (!permission.allowed) return permission.result;

        const content = readFileSync(filePath, "utf-8");

        const index = content.indexOf(oldText);
        if (index === -1) {
          return JSON.stringify({ error: "未找到匹配的文本" });
        }

        const secondIndex = content.indexOf(oldText, index + 1);
        if (secondIndex !== -1) {
          return JSON.stringify({ error: "匹配不唯一，找到多处相同文本，请提供更具体的上下文" });
        }

        const newContent = content.slice(0, index) + newText + content.slice(index + oldText.length);
        writeFileSync(filePath, newContent, "utf-8");

        return JSON.stringify({ path: filePath, replaced: true });
      } catch (err) {
        return JSON.stringify({
          error: `编辑失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
