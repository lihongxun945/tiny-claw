import { afterEach, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSystemPrompt } from "../../src/prompts/build.js";
import { corePromptsPlugin } from "../../src/plugins/core/prompts.js";
import type { HookContext, PluginContext, PluginHooks } from "../../src/plugins/types.js";
import { loadConfig } from "../../src/config.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

afterEach(() => { vi.useRealTimers(); });

it.each([false, true])("does not inject dates across days (custom template: %s)", async custom => {
  const workspace = createTempWorkspace();
  try {
    if (custom) writeFileSync(resolve(workspace, "system_prompt.md"), "Test {{current_date}} {{tools}}");
    let hooks!: PluginHooks;
    await corePromptsPlugin.init({ workspacePath: workspace, registerHooks(value: PluginHooks) { hooks = value; } } as PluginContext);
    const hook = { config: loadConfig(workspace) } as HookContext;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
    const first = buildSystemPrompt(workspace, []);
    const pluginFirst = await hooks.onBuildPrompt!(hook, "");
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    expect(buildSystemPrompt(workspace, [])).toBe(first);
    expect(await hooks.onBuildPrompt!(hook, "")).toBe(pluginFirst);
    for (const prompt of [first, pluginFirst]) {
      expect(prompt).not.toContain("2026-09-");
      expect(prompt).not.toContain("{{current_date}}");
      expect(prompt).not.toContain("当前日期");
    }
  } finally { removeTempWorkspace(workspace); }
});
