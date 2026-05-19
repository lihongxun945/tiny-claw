import { spawn } from "node:child_process";
import type { Tool } from "./types.js";

const MAX_OUTPUT = 10000;
const DEFAULT_TIMEOUT = 30;

export function createBashTool(): Tool {
  return {
    name: "bash",
    description:
      "在 shell 中执行命令并返回输出。用于运行 git、npm、ls 等命令。不要用于读取文件（用 file_read）或写入文件（用 file_write/file_edit）。",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的 shell 命令",
        },
        timeout: {
          type: "number",
          description: "超时秒数，默认30",
          minimum: 1,
          maximum: 300,
        },
      },
      required: ["command"],
    },
    execute: async (args) => {
      const command = args.command as string;
      const timeout = (args.timeout as number) ?? DEFAULT_TIMEOUT;

      return new Promise((resolve) => {
        const proc = spawn("bash", ["-c", command], {
          cwd: process.cwd(),
          env: process.env,
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        proc.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        const timer = setTimeout(() => {
          proc.kill("SIGTERM");
          stderr += "\n[超时: 命令执行超过指定时间]";
        }, timeout * 1000);

        proc.on("close", (code) => {
          clearTimeout(timer);
          resolve(
            JSON.stringify({
              stdout: truncate(stdout, MAX_OUTPUT),
              stderr: truncate(stderr, MAX_OUTPUT),
              exitCode: code ?? -1,
            }),
          );
        });

        proc.on("error", (err) => {
          clearTimeout(timer);
          resolve(
            JSON.stringify({
              stdout: "",
              stderr: err.message,
              exitCode: -1,
            }),
          );
        });
      });
    },
  };
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n...[输出截断，共 ${str.length} 字符]`;
}
