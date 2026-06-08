import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Tool } from "../types.js";
import type { Config } from "../types.js";
import { checkDangerousToolPermission } from "./permission.js";

const MAX_OUTPUT = 10000;
const DEFAULT_TIMEOUT = 30;

export function createBashTool(workspacePath: string, getConfig: () => Config): Tool {
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
        cwd: {
          type: "string",
          description: "执行目录（相对 workspace 或绝对路径），默认 workspace",
        },
      },
      required: ["command"],
    },
    execute: async (args, context) => {
      const command = args.command as string;
      const timeout = (args.timeout as number) ?? DEFAULT_TIMEOUT;
      const cwd = resolve(workspacePath, (args.cwd as string | undefined) ?? ".");
      const permission = checkDangerousToolPermission({
        workspacePath,
        config: getConfig(),
        toolName: "bash",
        args,
        context,
        command,
        cwd,
      });
      if (!permission.allowed) return permission.result;

      return execute(command, timeout, cwd, context?.signal);
    },
  };
}

function execute(command: string, timeout: number, cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(JSON.stringify({ stdout: "", stderr: "命令执行已取消", exitCode: -1 }));
      return;
    }
    const proc = spawn("bash", ["-c", command], {
      cwd,
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
    const onAbort = () => {
      proc.kill("SIGTERM");
      stderr += "\n[已取消: 命令执行被用户中止]";
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
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
      signal?.removeEventListener("abort", onAbort);
      resolve(
        JSON.stringify({
          stdout: "",
          stderr: err.message,
          exitCode: -1,
        }),
      );
    });
  });
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n...[输出截断，共 ${str.length} 字符]`;
}
