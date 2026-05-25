import type { Plugin } from "../types.js";
import type { Message } from "../../types.js";

export const coreHistoryPlugin: Plugin = {
  name: "core-history",
  async init(ctx) {
    ctx.registerHooks({
      onUserMessage: (hookCtx, input) => {
        const userMsg: Message = { role: "user", content: input, _timestamp: Date.now() };
        hookCtx.history.markTurnStart();
        hookCtx.history.push(userMsg);
      },
    });
  },
};
