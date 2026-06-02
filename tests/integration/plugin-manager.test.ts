import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../../src/config.js";
import { MessageHistory } from "../../src/history.js";
import { PluginManager } from "../../src/plugin-manager.js";
import { destroyPlugins, loadPlugins } from "../../src/plugins/loader.js";
import type { ModelClient } from "../../src/model/index.js";
import type { PluginContext, PluginHooks } from "../../src/plugins/types.js";
import type { AgentSession } from "../../src/agent.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

function modelClient(): ModelClient {
  return {
    complete: async () => "complete",
    chat: async () => ({ text: "chat", toolCalls: [] }),
  };
}

function addHooks(manager: PluginManager, hooks: PluginHooks): void {
  (manager as unknown as { hooks: PluginHooks[] }).hooks.push(hooks);
}

function createContext(manager: PluginManager, pluginName: string): PluginContext {
  return (manager as unknown as {
    createPluginContext: (name: string) => PluginContext;
  }).createPluginContext(pluginName);
}

describe("PluginManager hook lifecycle", () => {
  let workspacePath: string;
  let manager: PluginManager;

  beforeEach(() => {
    workspacePath = createTempWorkspace();
    manager = new PluginManager(workspacePath);
    manager.setRuntimeDeps(loadConfig(workspacePath), modelClient(), new MessageHistory(), "main");
  });

  afterEach(async () => {
    await manager.destroy();
    removeTempWorkspace(workspacePath);
  });

  it("runs chat lifecycle hooks in registration order and applies transformations", async () => {
    const calls: string[] = [];
    addHooks(manager, {
      onBeforeChat: (_ctx, input) => {
        calls.push("before-chat-1");
        return { input: `${input}-first` };
      },
      onBuildPrompt: (_ctx, prompt) => {
        calls.push("build-prompt-1");
        return `${prompt}base`;
      },
      onBeforeModelCall: (_ctx, messages) => {
        calls.push("before-model-1");
        return [...messages, { role: "user", content: "from-hook" }];
      },
      onChatResponse: (_ctx, response) => {
        calls.push("chat-response-1");
        return { ...response, text: `${response.text}-first` };
      },
    });
    addHooks(manager, {
      onBeforeChat: (_ctx, input) => {
        calls.push("before-chat-2");
        return { input: `${input}-second` };
      },
      onBuildPrompt: (_ctx, prompt) => {
        calls.push("build-prompt-2");
        return `${prompt}-extended`;
      },
      onBeforeModelCall: (_ctx, messages) => {
        calls.push("before-model-2");
        return [...messages, { role: "assistant", content: "second-hook" }];
      },
      onChatResponse: (_ctx, response) => {
        calls.push("chat-response-2");
        return { ...response, text: `${response.text}-second` };
      },
    });

    expect(await manager.callOnBeforeChat("input", "main")).toEqual({
      input: "input-first-second",
    });
    expect(await manager.callOnBuildPrompt("", "main")).toBe("base-extended");
    expect(await manager.callOnBeforeModelCall([], 0, 1, "main")).toEqual([
      { role: "user", content: "from-hook" },
      { role: "assistant", content: "second-hook" },
    ]);
    expect(await manager.callOnChatResponse({ text: "response", toolCalls: [] }, 1, "main")).toEqual({
      text: "response-first-second",
      toolCalls: [],
    });
    expect(calls).toEqual([
      "before-chat-1",
      "before-chat-2",
      "build-prompt-1",
      "build-prompt-2",
      "before-model-1",
      "before-model-2",
      "chat-response-1",
      "chat-response-2",
    ]);
  });

  it("supports aborting chat and tool execution", async () => {
    addHooks(manager, {
      onBeforeChat: () => ({ abort: "chat blocked" }),
      onBeforeTool: (_ctx, name) => name === "bash" ? { abort: "tool blocked" } : undefined,
    });

    expect(await manager.callOnBeforeChat("input", "main")).toEqual({
      input: "input",
      abort: "chat blocked",
    });
    expect(await manager.callOnBeforeTool("bash", {}, 1, "main")).toEqual({
      abort: "tool blocked",
    });
  });

  it("passes tool results through hooks and emits iteration and error hooks", async () => {
    const onAfterIteration = vi.fn();
    const onError = vi.fn();
    addHooks(manager, {
      onAfterTool: (_ctx, name, result) => `${name}:${result}`,
      onAfterIteration,
      onError,
    });

    expect(await manager.callOnAfterTool("echo", "ok", 2, "main")).toBe("echo:ok");
    await manager.callOnAfterIteration(2, "main");
    const error = new Error("failed");
    await manager.callOnError(error, 2, "main");

    expect(onAfterIteration).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "main",
      iteration: 2,
    }), error);
  });

  it("uses session-specific history dependencies", async () => {
    const mainHistory = new MessageHistory();
    const secondHistory = new MessageHistory();
    manager.setRuntimeDeps(loadConfig(workspacePath), modelClient(), mainHistory, "main");
    manager.setRuntimeDeps(loadConfig(workspacePath), modelClient(), secondHistory, "second");
    addHooks(manager, {
      onUserMessage: (ctx, input) => {
        ctx.history.push({ role: "user", content: input });
      },
    });

    await manager.callOnUserMessage("main-message", "main");
    await manager.callOnUserMessage("second-message", "second");

    expect(mainHistory.getRecentMessages(Infinity)).toEqual([
      { role: "user", content: "main-message" },
    ]);
    expect(secondHistory.getRecentMessages(Infinity)).toEqual([
      { role: "user", content: "second-message" },
    ]);
  });

  it("registers core tools and applies tool permission filters", async () => {
    const filteredManager = new PluginManager(workspacePath, {
      allowedTools: ["web_search", "memory_list"],
      disabledTools: ["memory_list"],
    });
    filteredManager.setRuntimeDeps(loadConfig(workspacePath), modelClient(), new MessageHistory(), "filtered");
    await filteredManager.loadCorePlugins();

    expect(filteredManager.getToolDefinitions().map((tool) => tool.name)).toEqual(["web_search"]);
    await filteredManager.destroy();
  });

  it("provides routes, prompt sections, session factory and plugin config through context", () => {
    const session = {} as AgentSession;
    const getOrCreateSession = vi.fn(() => session);
    const deleteSession = vi.fn(() => true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    manager.setPluginConfigs({ custom: { enabled: true } });
    manager.setSessionFactory({ getOrCreateSession, deleteSession });
    const ctx = createContext(manager, "custom");

    ctx.registerRoute({
      method: "GET",
      path: "/custom",
      handler: async () => {},
    });
    ctx.extendPrompt({ title: "custom", content: "section", priority: 1 });
    ctx.log("INFO", "hello", "main");

    expect(ctx.config).toEqual({ enabled: true });
    expect(manager.getRoutes()).toEqual([
      expect.objectContaining({ method: "GET", path: "/custom", pluginName: "custom" }),
    ]);
    expect(manager.getPromptSections()).toEqual([
      { title: "custom", content: "section", priority: 1 },
    ]);
    expect(ctx.getOrCreateSession("id", "prefix")).toBe(session);
    expect(ctx.deleteSession("id")).toBe(true);
    expect(getOrCreateSession).toHaveBeenCalledWith("id", "prefix");
    expect(deleteSession).toHaveBeenCalledWith("id");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[custom] [main] hello"));
  });

  it("destroys plugins without stopping after a plugin failure", async () => {
    const destroyed: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await destroyPlugins([
      {
        name: "first",
        init: async () => {},
        destroy: async () => {
          destroyed.push("first");
          throw new Error("destroy failed");
        },
      },
      {
        name: "second",
        init: async () => {},
        destroy: async () => {
          destroyed.push("second");
        },
      },
    ]);

    expect(destroyed).toEqual(["first", "second"]);
    expect(consoleError).toHaveBeenCalledWith("插件 first 销毁失败: destroy failed");
  });
});

describe("plugin loader", () => {
  it("loads external plugins and initializes their context", async () => {
    const registerTool = vi.fn();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const url = pathToFileURL(resolve("tests/fixtures/plugins/external-valid.js")).href;
    const plugins = await loadPlugins({ external: [url] }, () => ({
      registerTool,
    } as unknown as PluginContext));

    expect(plugins.map((plugin) => plugin.name)).toEqual(["external-valid"]);
    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "external_echo",
    }));
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("external-valid"));
  });

  it("rejects invalid external plugins", async () => {
    const url = pathToFileURL(resolve("tests/fixtures/plugins/external-invalid.js")).href;

    await expect(loadPlugins({ external: [url] }, () => ({} as PluginContext)))
      .rejects.toThrow(`外部插件 "${url}" 未导出有效的 Plugin`);
  });
});
