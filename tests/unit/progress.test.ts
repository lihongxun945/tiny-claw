import { afterEach, describe, expect, it, vi } from "vitest";
import { coreProgressPlugin } from "../../src/plugins/core/progress.js";
import type { HookContext, ModelCallContext, PluginContext, PluginHooks } from "../../src/plugins/types.js";
import { createDefaultConfig, validateConfig } from "../../src/config.js";

afterEach(() => { vi.restoreAllMocks(); });
let now = 0;

async function setup() {
  now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let hooks!: PluginHooks;
  await coreProgressPlugin.init({ registerHooks(value: PluginHooks) { hooks = value; } } as PluginContext);
  const hook = { sessionId: "a", turnId: "one", config: {} } as HookContext;
  const request = { messages: [{ role: "user", content: "任务" }], turnStartIndex: 0 } as ModelCallContext;
  const tool = () => hooks.onAfterTool!(hook, "file_read", "ok");
  const before = () => hooks.onBeforeModelCall!(hook, request);
  return { hooks, hook, request, tool, before };
}

describe("progress reminders", () => {
  it("reminds after five tools without mutating history, then throttles ignored reminders", async () => {
    const { before, tool, request } = await setup();
    expect(before()).toBeUndefined();
    for (let i = 0; i < 5; i++) tool();
    const result = await before();
    expect(result?.messages.at(-1)?.content).toContain("执行进展提醒");
    expect(request.messages).toHaveLength(1);
    tool();
    expect(before()).toBeUndefined();
  });
  it("uses elapsed time only after tool activity and resets after visible text", async () => {
    const { before, tool, hooks, hook } = await setup();
    before();
    now = 60000;
    expect(before()).toBeUndefined();
    tool();
    expect(await before()).toBeDefined();
    tool();
    await hooks.onChatResponse!(hook, { text: "已确认原因", toolCalls: [] });
    now = 120000;
    expect(before()).toBeUndefined();
  });
  it("isolates sessions and turns, clears on pause/error, and respects configuration", async () => {
    const { before, tool, hooks, hook } = await setup();
    hook.config.progress = { toolCalls: 1, silenceMs: 100 };
    tool();
    hook.sessionId = "b";
    expect(before()).toBeUndefined();
    hook.sessionId = "a";
    expect(await before()).toBeDefined();
    tool();
    hook.turnId = "two";
    expect(before()).toBeUndefined();
    tool();
    await hooks.onTurnEnd!(hook, "approval_required");
    expect(before()).toBeUndefined();
    tool();
    await hooks.onError!(hook, new Error("failed"));
    expect(before()).toBeUndefined();
    hook.config.progress.enabled = false;
    tool();
    expect(before()).toBeUndefined();
    expect(hooks.onBuildPrompt!(hook, "base")).toBeUndefined();
    hook.config.progress.enabled = true;
    expect(hooks.onBuildPrompt!(hook, "base")).toContain("执行过程沟通");
  });
  it("rejects invalid progress settings", () => {
    for (const progress of [{ silenceMs: 0 }, { toolCalls: 1.5 }, { enabled: "yes" }]) {
      expect(() => validateConfig({ ...createDefaultConfig(), progress })).toThrow(/progress/);
    }
  });
});
