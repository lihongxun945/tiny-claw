import type { Plugin } from "../types.js";
import type { Message } from "../../types.js";
import { appendHistory } from "../../workspace/logger.js";

export const coreHistoryPlugin: Plugin = {
  name: "core-history",
  async init(ctx) {
    ctx.registerHooks({
      onUserMessage: (hookCtx, input, content) => {
        const userMsg: Message = { role: "user", content: content ?? input, _timestamp: Date.now(), _turnId: hookCtx.turnId };
        hookCtx.history.markTurnStart();
        hookCtx.history.push(userMsg);
        appendHistory(ctx.workspacePath, userMsg, hookCtx.sessionId);
      },
    });
  },
};
