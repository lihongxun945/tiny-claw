import type { Plugin, HookContext } from "../types.js";
import { appendLog } from "../../workspace/logger.js";

export const coreLoggerPlugin: Plugin = {
  name: "core-logger",
  async init(ctx) {
    const workspacePath = ctx.workspacePath;

    ctx.registerHooks({
      // 用户消息日志；完整会话消息由 core-history 持久化。
      onBeforeChat: (_ctx: HookContext, input: string) => {
        appendLog(workspacePath, "INFO", `用户输入: ${input}`, _ctx.sessionId);
      },

      // 工具调用前：记录到日志
      onBeforeTool: (_ctx: HookContext, name: string, args: Record<string, unknown>) => {
        appendLog(workspacePath, "TOOL", `调用: ${name}(${JSON.stringify(args)})`, _ctx.sessionId);
      },

      // 工具结果：记录到日志
      onAfterTool: (_ctx: HookContext, name: string, result: string) => {
        appendLog(workspacePath, "TOOL", `结果: ${result.slice(0, 500)}`, _ctx.sessionId);
        return result;
      },

      // 错误：记录到日志
      onError: (_ctx: HookContext, error: Error) => {
        appendLog(workspacePath, "ERROR", error.message, _ctx.sessionId);
      },
    });
  },
};
