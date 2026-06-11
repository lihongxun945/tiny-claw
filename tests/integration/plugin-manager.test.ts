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
import type { Message } from "../../src/types.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";
import { getMemoryRecord, saveMemory } from "../../src/tools/memory.js";
import { loadSessionState, saveSessionState } from "../../src/session-state.js";

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

  it("lets plugins register chat commands", async () => {
    const ctx = createContext(manager, "custom-commands");
    ctx.registerChatCommand({
      name: "hello",
      description: "say hello",
      usage: "/hello <name>",
      execute: ({ args, rawInput }) => ({ text: `hello ${args[0] ?? "world"} from ${rawInput}` }),
    });

    await expect(manager.executeChatCommand("/hello codex", {
      sessionId: "main",
      channel: "web",
    })).resolves.toEqual({
      text: "hello codex from /hello codex",
    });
    await expect(manager.executeChatCommand("hello codex", {
      sessionId: "main",
      channel: "web",
    })).resolves.toBeUndefined();
    await expect(manager.executeChatCommand("/missing", {
      sessionId: "main",
      channel: "web",
    })).resolves.toEqual({
      text: "未知命令：/missing\n发送 /help 查看可用命令。",
    });
  });

  it("runs /dream through the auto-memory analyzer", async () => {
    const dreamWorkspace = createTempWorkspace({
      autoMemory: { enabled: true, mode: "auto", turnThreshold: 2 },
      sessionSummary: { enabled: false },
    });
    const dreamManager = new PluginManager(dreamWorkspace);
    const chatCalls: Message[][] = [];
    const chatTools: string[][] = [];
    const client: ModelClient = {
      complete: async () => "unused",
      chat: async (messages, _onDelta, tools) => {
        chatCalls.push([...messages]);
        chatTools.push((tools ?? []).map((tool) => tool.name).sort());
        if (chatCalls.length === 1) {
          return {
            text: "",
            toolCalls: [{
              type: "tool_use",
              id: "dream-save",
              name: "memory_save",
              input: {
                name: "dream-memory",
                summary: "梦境整理记忆",
                content: "用户希望 /dream 可以立即触发长期记忆整理。",
                tags: ["memory"],
                scope: "project",
              },
            }],
          };
        }
        return { text: "已整理 /dream 相关长期记忆。", toolCalls: [] };
      },
    };
    const history = new MessageHistory();

    try {
      await dreamManager.loadCorePlugins();
      saveSessionState(dreamWorkspace, {
        sessionId: "dream-session",
        summary: "",
        pendingMessages: [],
        turnsSinceSummary: 0,
        autoMemory: {
          pendingTurns: [{
            user: "我需要 /dream 触发 auto-memory",
            assistant: "最终回答：会增加 /dream 命令",
            at: new Date(6).toISOString(),
          }],
          turnsSinceAnalysis: 1,
        },
      });
      dreamManager.setRuntimeDeps(loadConfig(dreamWorkspace), client, history, "dream-session");

      const result = await dreamManager.executeChatCommand("/dream", {
        sessionId: "dream-session",
        channel: "web",
      });

      expect(result?.text).toContain("已完成记忆整理");
      expect(result?.text).toContain("- 保存/更新：1");
      expect(getMemoryRecord(dreamWorkspace, "dream-memory")?.content).toBe("用户希望 /dream 可以立即触发长期记忆整理。");
      expect(chatCalls).toHaveLength(2);
      expect(String(chatCalls[0][0].content)).toContain("[user] 我需要 /dream 触发 auto-memory");
      expect(String(chatCalls[0][0].content)).toContain("[assistant] 最终回答：会增加 /dream 命令");
      expect(chatTools[0]).toEqual(["memory_delete", "memory_list", "memory_read", "memory_save"]);
      expect(loadSessionState(dreamWorkspace, "dream-session").autoMemory.pendingTurns).toHaveLength(0);
    } finally {
      await dreamManager.destroy();
      removeTempWorkspace(dreamWorkspace);
    }
  });

  it("runs /dream even when there are no pending turns", async () => {
    const dreamWorkspace = createTempWorkspace();
    const dreamManager = new PluginManager(dreamWorkspace);
    const chatCalls: Message[][] = [];
    const client: ModelClient = {
      complete: async () => "unused",
      chat: async (messages) => {
        chatCalls.push([...messages]);
        return { text: "已有记忆无需更新。", toolCalls: [] };
      },
    };
    try {
      await dreamManager.loadCorePlugins();
      saveMemory(dreamWorkspace, "existing-memory", "用户希望记忆整理可以手动触发。", { source: "manual" });
      dreamManager.setRuntimeDeps(loadConfig(dreamWorkspace), client, new MessageHistory(), "empty-dream");

      await expect(dreamManager.executeChatCommand("/dream", {
        sessionId: "empty-dream",
        channel: "web",
      })).resolves.toEqual(expect.objectContaining({
        text: expect.stringContaining("已完成记忆整理"),
      }));
      expect(chatCalls).toHaveLength(1);
      const prompt = String(chatCalls[0][0].content);
      expect(prompt).toContain("## existing-memory");
      expect(prompt).toContain("本次没有新增对话");
    } finally {
      await dreamManager.destroy();
      removeTempWorkspace(dreamWorkspace);
    }
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
