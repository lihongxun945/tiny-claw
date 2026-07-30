import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";
import { startTestGateway, type TestGateway } from "../helpers/start-gateway.js";
import { loadSessionState, saveSessionState } from "../../src/session-state.js";
import { appendSessionMessage } from "../../src/session-store.js";

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function sse(url: string, init?: RequestInit): Promise<Array<{ event: string; data: any }>> {
  const response = await fetch(url, init);
  expect(response.status).toBe(200);
  const text = await response.text();
  return text.trim().split("\n\n").filter(Boolean).map((chunk) => {
    const event = chunk.split("\n").find((line) => line.startsWith("event: "))?.slice(7) ?? "";
    const data = chunk.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
    return { event, data: JSON.parse(data) };
  });
}

describe("Gateway HTTP API", () => {
  let workspacePath: string;
  let gateway: TestGateway;

  beforeEach(async () => {
    workspacePath = createTempWorkspace({
      ollamaApiKey: "ollama-secret",
      plugins: {
        demo: {
          appSecret: "plugin-secret",
          verificationToken: "plugin-token",
        },
      },
    });
    gateway = await startTestGateway(workspacePath);
  });

  afterEach(async () => {
    await gateway.stop();
    removeTempWorkspace(workspacePath);
  });

  it("masks nested secrets and preserves them when masked config is saved", async () => {
    const before = await json(`${gateway.apiUrl}/config`);
    expect(before.status).toBe(200);
    expect(before.body.config).toMatchObject({
      apiKey: "test***",
      ollamaApiKey: "olla***",
      plugins: {
        demo: {
          appSecret: "plug***",
          verificationToken: "plug***",
        },
      },
    });

    const saved = await json(`${gateway.apiUrl}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(before.body.config),
    });
    expect(saved.status).toBe(200);

    const disk = JSON.parse(readFileSync(resolve(workspacePath, "config.json"), "utf-8"));
    expect(disk).toMatchObject({
      apiKey: "test-api-key",
      ollamaApiKey: "ollama-secret",
      plugins: {
        demo: {
          appSecret: "plugin-secret",
          verificationToken: "plugin-token",
        },
      },
    });
  });

  it("starts with a generated first-run config when config.json is missing", async () => {
    await gateway.stop();
    rmSync(resolve(workspacePath, "config.json"));
    gateway = await startTestGateway(workspacePath);

    const response = await json(`${gateway.apiUrl}/config`);
    expect(response.status).toBe(200);
    expect(response.body.config).toMatchObject({
      apiUrl: "https://api.deepseek.com",
      apiKey: "",
      model: "deepseek-chat",
      searchProvider: "duckduckgo",
      enabledPlugins: [],
      plugins: {},
    });
  });

  it("reloads an idle session after model configuration changes", async () => {
    writeFileSync(resolve(workspacePath, "config.json"), JSON.stringify({
      apiUrl: "https://example.com/api",
      apiKey: "",
      model: "test-model",
    }), "utf-8");
    await gateway.stop();
    gateway = await startTestGateway(workspacePath);

    const before = await sse(`${gateway.apiUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello", session_id: "config-reload" }),
    });
    expect(before).toContainEqual({
      event: "error",
      data: { message: "尚未配置模型 API Key，请先在配置页面填写并保存。" },
    });

    const saved = await json(`${gateway.apiUrl}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "configured-key" }),
    });
    expect(saved.status).toBe(200);
    expect((await json(`${gateway.apiUrl}/sessions`)).body.sessions).toEqual([]);
  });

  it("strips deprecated auto-memory config fields from config API", async () => {
    const configPath = resolve(workspacePath, "config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    writeFileSync(configPath, JSON.stringify({
      ...raw,
      autoMemory: {
        enabled: true,
        mode: "hybrid",
        turnThreshold: 10,
        minConfidence: 0.75,
        maxCandidates: 5,
      },
    }, null, 2), "utf-8");

    const before = await json(`${gateway.apiUrl}/config`);
    expect(before.status).toBe(200);
    expect(before.body.config.autoMemory).toEqual({
      enabled: true,
      mode: "hybrid",
      turnThreshold: 10,
      maxCandidates: 5,
    });

    const saved = await json(`${gateway.apiUrl}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(before.body.config),
    });
    expect(saved.status).toBe(200);
    expect(JSON.parse(readFileSync(configPath, "utf-8")).autoMemory).toEqual({
      enabled: true,
      mode: "hybrid",
      turnThreshold: 10,
      maxCandidates: 5,
    });
  });

  it("rejects invalid config updates without writing them to disk", async () => {
    const configPath = resolve(workspacePath, "config.json");
    const before = readFileSync(configPath, "utf-8");
    const result = await json(`${gateway.apiUrl}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxTokens: 0 }),
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("配置字段 maxTokens 超出允许范围");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("supports memory CRUD and enable/disable operations", async () => {
    writeFileSync(resolve(workspacePath, "memory", "project.md"), [
      "---",
      "name: project",
      "tags: [tiny-claw]",
      "createdAt: 2026-06-02T00:00:00.000Z",
      "updatedAt: 2026-06-02T00:00:00.000Z",
      "disabled: false",
      "scope: project",
      "source: manual",
      "summary: 项目背景",
      "---",
      "",
      "tiny-claw project",
      "",
    ].join("\n"), "utf-8");

    expect((await json(`${gateway.apiUrl}/memory?include_disabled=true`)).body.memories).toHaveLength(1);
    expect((await json(`${gateway.apiUrl}/memory/project`)).body.memory).toMatchObject({
      name: "project",
      summary: "项目背景",
    });

    const updated = await json(`${gateway.apiUrl}/memory/project`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "updated project", tags: ["updated"] }),
    });
    expect(updated.body.memory).toMatchObject({
      content: "updated project",
      tags: ["updated"],
    });

    expect((await json(`${gateway.apiUrl}/memory/project/disable`, { method: "POST" })).body.memory.disabled).toBe(true);
    expect((await json(`${gateway.apiUrl}/memory/project/enable`, { method: "POST" })).body.memory.disabled).toBe(false);
    expect((await json(`${gateway.apiUrl}/memory/project`, { method: "DELETE" })).body.deleted).toBe(true);
    expect((await json(`${gateway.apiUrl}/memory/project`)).status).toBe(404);
  });

  it("filters sub-agent sessions and deletes persisted session messages", async () => {
    appendSessionMessage(workspacePath, "main", { role: "user", content: "main question", _timestamp: 2 });
    appendSessionMessage(workspacePath, "main", { role: "assistant", content: "main answer", _timestamp: 3 });
    appendSessionMessage(workspacePath, "sub:main:worker", { role: "user", content: "sub question", _timestamp: 4 });

    const sessions = await json(`${gateway.apiUrl}/history/sessions`);
    expect(sessions.body.sessions.map((session: { id: string }) => session.id)).toEqual(["main"]);
    expect((await json(`${gateway.apiUrl}/history/sessions/main/messages`)).body.messages).toEqual([
      expect.objectContaining({ role: "user", text: "main question" }),
      expect.objectContaining({ role: "assistant", text: "main answer" }),
    ]);

    const deleted = await json(`${gateway.apiUrl}/sessions/main`, { method: "DELETE" });
    expect(deleted.body).toEqual({ deleted: true, deletedHistoryRecords: 2, deletedSessionState: false });
    expect((await json(`${gateway.apiUrl}/history/sessions`)).body.sessions).toEqual([]);
  });

  it("deletes persisted session messages for encoded session ids", async () => {
    const sessionId = "web/session?special#id";
    appendSessionMessage(workspacePath, sessionId, { role: "user", content: "special question", _timestamp: 2 });
    appendSessionMessage(workspacePath, sessionId, { role: "assistant", content: "special answer", _timestamp: 3 });

    expect((await json(`${gateway.apiUrl}/history/sessions`)).body.sessions.map((session: { id: string }) => session.id)).toEqual([sessionId]);

    const deleted = await json(`${gateway.apiUrl}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    expect(deleted.body).toEqual({ deleted: true, deletedHistoryRecords: 2, deletedSessionState: false });
    expect((await json(`${gateway.apiUrl}/history/sessions`)).body.sessions).toEqual([]);
  });

  it("proxies DELETE session requests without sending an empty body", async () => {
    const sessionId = "web-proxy-delete";
    appendSessionMessage(workspacePath, sessionId, { role: "user", content: "delete through web proxy", _timestamp: 2 });

    const deleted = await json(`${gateway.webUrl}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    expect(deleted).toEqual({ status: 200, body: { deleted: true, deletedHistoryRecords: 1, deletedSessionState: false } });
    expect((await json(`${gateway.apiUrl}/history/sessions`)).body.sessions).toEqual([]);
  });

  it("deletes persisted session state with the session", async () => {
    saveSessionState(workspacePath, {
      sessionId: "stateful-session",
      summary: "持久化摘要",
      pendingMessages: [],
      turnsSinceSummary: 0,
    });

    const deleted = await json(`${gateway.apiUrl}/sessions/stateful-session`, { method: "DELETE" });
    expect(deleted).toEqual({
      status: 200,
      body: { deleted: true, deletedHistoryRecords: 0, deletedSessionState: true },
    });
    expect(loadSessionState(workspacePath, "stateful-session").summary).toBe("");
  });

  it("restores persisted tool results after a page refresh", async () => {
    appendSessionMessage(workspacePath, "tool-history", { role: "user", content: "run pwd", _timestamp: 1 });
    appendSessionMessage(workspacePath, "tool-history", {
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }],
      _timestamp: 2,
    });
    appendSessionMessage(workspacePath, "tool-history", {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: "{\"error\":\"bash 执行已禁用\"}" }],
      _timestamp: 3,
    });

    expect((await json(`${gateway.apiUrl}/history/sessions/tool-history/messages`)).body.messages).toEqual([
      expect.objectContaining({ role: "user", text: "run pwd" }),
      expect.objectContaining({
        role: "assistant",
        toolCalls: [{
          id: "call-1",
          name: "bash",
          input: { command: "pwd" },
          result: "{\"error\":\"bash 执行已禁用\"}",
        }],
      }),
    ]);
  });

  it("serves WebUI static files and proxies memory API", async () => {
    const page = await fetch(`${gateway.webUrl}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");

    const proxied = await json(`${gateway.webUrl}/memory?include_disabled=true`);
    expect(proxied).toEqual({ status: 200, body: { memories: [] } });
  });

  it("handles slash commands before entering the agent loop", async () => {
    const events = await sse(`${gateway.apiUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "/help" }),
    });

    expect(events).toEqual([
      expect.objectContaining({
        event: "text_delta",
        data: expect.objectContaining({ text: expect.stringContaining("- `/help [命令名]`：列出可用聊天命令") }),
      }),
      expect.objectContaining({
        event: "done",
        data: expect.objectContaining({ text: expect.stringContaining("- `/approvals`：列出当前可处理的命令审批") }),
      }),
    ]);
  });

  it("creates a fresh session for /new", async () => {
    const events = await sse(`${gateway.apiUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "/new", session_id: "old-session" }),
    });

    const done = events.find((event) => event.event === "done");
    expect(done?.data).toMatchObject({
      text: expect.stringContaining("已创建新会话"),
      clear_messages: true,
    });
    expect(done?.data.session_id).toBeTruthy();
    expect(done?.data.session_id).not.toBe("old-session");
  });

  it("reports context length for the active session", async () => {
    appendSessionMessage(workspacePath, "ctx-session", { role: "user", content: "hello context", _timestamp: 1 });
    appendSessionMessage(workspacePath, "ctx-session", { role: "assistant", content: [{ type: "text", text: "context reply" }], _timestamp: 2 });

    const events = await sse(`${gateway.apiUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "/context", session_id: "ctx-session" }),
    });

    const done = events.find((event) => event.event === "done");
    expect(done?.data).toMatchObject({
      session_id: "ctx-session",
      text: expect.stringContaining("当前上下文长度估算"),
    });
    expect(done?.data.text).toContain("当前发送窗口");
    expect(done?.data.text).toContain("会话完整历史");
  });

  it("exposes approval API and proxies it through the WebUI server", async () => {
    expect(await json(`${gateway.apiUrl}/approvals`)).toEqual({ status: 200, body: { approvals: [] } });
    expect(await json(`${gateway.webUrl}/approvals`)).toEqual({ status: 200, body: { approvals: [] } });
    expect((await json(`${gateway.apiUrl}/approvals/missing/approve`, { method: "POST" })).status).toBe(404);
    expect((await json(`${gateway.apiUrl}/approvals/missing/reject`, { method: "POST" })).status).toBe(404);
  });

  it("returns not found when cancelling an unknown session", async () => {
    expect((await json(`${gateway.apiUrl}/sessions/missing/cancel`, { method: "POST" })).status).toBe(404);
  });
});

describe("Gateway token authentication", () => {
  let workspacePath: string;
  let gateway: TestGateway;

  beforeEach(async () => {
    workspacePath = createTempWorkspace({
      security: {
        gateway: {
          token: "gateway-secret",
        },
      },
    });
    gateway = await startTestGateway(workspacePath, "gateway-secret");
  });

  afterEach(async () => {
    await gateway.stop();
    removeTempWorkspace(workspacePath);
  });

  it("rejects unauthenticated API requests and keeps the local WebUI proxy working", async () => {
    expect((await json(`${gateway.apiUrl}/sessions`)).status).toBe(401);
    expect((await json(`${gateway.apiUrl}/sessions`, {
      headers: { authorization: "Bearer gateway-secret" },
    })).status).toBe(200);
    expect((await json(`${gateway.webUrl}/sessions`)).status).toBe(200);
  });
});
