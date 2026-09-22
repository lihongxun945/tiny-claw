import type { HookContext, Plugin } from "../types.js";

const GUIDANCE = "复杂任务开始前，用一两句话说明准备检查什么。执行中有关键发现、改变方向或遇到阻塞时，主动简短汇报已确认的事实和下一步；不要输出内部思考或机械复述工具名称。简单问题直接回答，不强制开场白。";
const REMINDER = "[执行进展提醒] 距离上次正文汇报已持续执行了一段时间。请先用一两句话向用户说明已确认的发现和下一步，再按需要继续调用工具；若信息已充分则直接给出最终回答。没有新发现时如实说明，不要编造进展，不要泄露内部思考。";

export const coreProgressPlugin: Plugin = {
  name: "core-progress",
  async init(ctx) {
    const states = new Map<string, { turnId: string; since: number; calls: number }>();
    const stateFor = (hook: HookContext) => {
      if (hook.config.progress?.enabled === false || !hook.turnId) return;
      let state = states.get(hook.sessionId);
      if (!state || state.turnId !== hook.turnId) {
        state = { turnId: hook.turnId, since: Date.now(), calls: 0 };
        states.set(hook.sessionId, state);
      }
      return state;
    };
    ctx.registerHooks({
      onBuildPrompt(hook, prompt) {
        if (hook.config.progress?.enabled !== false) return `${prompt}\n\n## 执行过程沟通\n${GUIDANCE}`;
      },
      onBeforeModelCall(hook, request) {
        const state = stateFor(hook);
        if (!state || state.calls === 0) return;
        const options = hook.config.progress;
        if (state.calls < (options?.toolCalls ?? 5) && Date.now() - state.since < (options?.silenceMs ?? 60000)) return;
        // Reset on reminder as well as text, so ignored reminders cannot flood every request.
        state.since = Date.now();
        state.calls = 0;
        return { ...request, messages: [...request.messages, { role: "user", content: REMINDER }] };
      },
      onChatResponse(hook, response) {
        const state = stateFor(hook);
        if (state && response.text.trim()) { state.since = Date.now(); state.calls = 0; }
      },
      onAfterTool(hook) {
        const state = stateFor(hook);
        if (state) state.calls++;
      },
      onTurnEnd(hook) { states.delete(hook.sessionId); },
      onError(hook) { states.delete(hook.sessionId); },
    });
  },
};
