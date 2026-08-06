import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";
import { startTestGateway, type TestGateway } from "../helpers/start-gateway.js";
import { loadSessionState, saveSessionState } from "../../src/session-state.js";
import { appendSessionMessage, readSessionMeta } from "../../src/session-store.js";
import { attachmentToImageBlock, readAttachment } from "../../src/attachments.js";
import { createSessionPlan, updateSessionPlanStep } from "../../src/plan-store.js";

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

  it("inspects projects through the production web proxy", async () => {
    writeFileSync(resolve(workspacePath, "package.json"), "{}", "utf-8");
    writeFileSync(resolve(workspacePath, "AGENTS.md"), "gateway project rule", "utf-8");
    const inspected = await json(`${gateway.webUrl}/projects/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: workspacePath }),
    });
    expect(inspected).toEqual({
      status: 200,
      body: {
        project: expect.objectContaining({
          root: realpathSync(workspacePath),
          stack: ["Node.js / npm"],
          rules: expect.stringContaining("gateway project rule"),
        }),
      },
    });
  });

  it("creates project sessions with a persistent immutable context", async () => {
    const created = await json(`${gateway.apiUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "project", projectRoot: workspacePath }),
    });
    expect(created.status).toBe(201);
    expect(created.body.session).toMatchObject({
      id: expect.any(String),
      context: { mode: "project", project: { root: realpathSync(workspacePath) } },
    });

    const sessions = await json(`${gateway.apiUrl}/history/sessions`);
    expect(sessions.body.sessions).toContainEqual(expect.objectContaining({
      id: created.body.session.id,
      context: expect.objectContaining({ mode: "project" }),
    }));
  });

  it("reuses the latest empty session for the same project when requested", async () => {
    const first = await json(`${gateway.apiUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "project", projectRoot: workspacePath, reuseEmpty: true }),
    });
    const second = await json(`${gateway.apiUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "project", projectRoot: workspacePath, reuseEmpty: true }),
    });

    expect(second.status).toBe(200);
    expect(second.body.session).toMatchObject({ id: first.body.session.id, reused: true });
  });

  it("serves persisted session plans through the WebUI proxy", async () => {
    const created = await json(`${gateway.apiUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "chat" }),
    });
    const firstTurnId = "11111111-1111-4111-8111-111111111111";
    const secondTurnId = "22222222-2222-4222-8222-222222222222";
    createSessionPlan(workspacePath, created.body.session.id, firstTurnId, ["分析", "实现"]);
    updateSessionPlanStep(workspacePath, created.body.session.id, firstTurnId, "step-1", "in_progress");
    updateSessionPlanStep(workspacePath, created.body.session.id, firstTurnId, "step-1", "completed");
    updateSessionPlanStep(workspacePath, created.body.session.id, firstTurnId, "step-2", "in_progress");
    const firstPlan = updateSessionPlanStep(workspacePath, created.body.session.id, firstTurnId, "step-2", "completed");
    createSessionPlan(workspacePath, created.body.session.id, secondTurnId, ["检查", "输出"]);
    updateSessionPlanStep(workspacePath, created.body.session.id, secondTurnId, "step-1", "in_progress");
    const secondPlan = updateSessionPlanStep(workspacePath, created.body.session.id, secondTurnId, "step-1", "failed", "检查失败");
    appendSessionMessage(workspacePath, created.body.session.id, { role: "user", content: "第一轮", _timestamp: 1, _turnId: firstTurnId });
    appendSessionMessage(workspacePath, created.body.session.id, { role: "assistant", content: "第一轮结果", _timestamp: 2, _turnId: firstTurnId });
    appendSessionMessage(workspacePath, created.body.session.id, { role: "user", content: "第二轮", _timestamp: 3, _turnId: secondTurnId });
    appendSessionMessage(workspacePath, created.body.session.id, { role: "assistant", content: "第二轮结果", _timestamp: 4, _turnId: secondTurnId });
    const response = await json(`${gateway.webUrl}/plan?session_id=${encodeURIComponent(created.body.session.id)}`);
    expect(response).toEqual({ status: 200, body: { plans: [firstPlan, secondPlan] } });
    const history = await json(`${gateway.webUrl}/history/sessions/${encodeURIComponent(created.body.session.id)}/messages`);
    expect(history.body.messages).toEqual([
      expect.objectContaining({ role: "user", turnId: firstTurnId }),
      expect.objectContaining({ role: "assistant", turnId: firstTurnId, plan: firstPlan }),
      expect.objectContaining({ role: "user", turnId: secondTurnId }),
      expect.objectContaining({ role: "assistant", turnId: secondTurnId, plan: secondPlan }),
    ]);
  });

  it("persists each session execution mode and rejects invalid values", async () => {
    const created = await json(`${gateway.apiUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "chat" }),
    });
    const sessionId = created.body.session.id as string;
    expect(created.body.session.executionMode).toBe("normal");

    expect(await json(`${gateway.apiUrl}/sessions/${sessionId}/execution-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionMode: "plan" }),
    })).toEqual({ status: 200, body: { executionMode: "plan" } });

    const sessions = await json(`${gateway.apiUrl}/history/sessions`);
    expect(sessions.body.sessions).toContainEqual(expect.objectContaining({ id: sessionId, executionMode: "plan" }));
    expect(readSessionMeta(workspacePath, sessionId)?.preferences.executionMode).toBe("plan");

    const invalid = await json(`${gateway.apiUrl}/sessions/${sessionId}/execution-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionMode: "invalid" }),
    });
    expect(invalid).toEqual({ status: 400, body: { error: "executionMode 仅支持 normal 或 plan" } });
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

  it("serves WebUI static files and proxies core plugin APIs", async () => {
    const page = await fetch(`${gateway.webUrl}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");

    const proxied = await json(`${gateway.webUrl}/memory?include_disabled=true`);
    expect(proxied).toEqual({ status: 200, body: { memories: [] } });

    const localModels = await json(`${gateway.webUrl}/local-models`);
    expect(localModels.status).toBe(200);
    expect(localModels.body.models).toHaveLength(11);
    expect(localModels.body.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qwen3.5-0.8b-q4", status: "idle" }),
      expect.objectContaining({ id: "qwen3.5-4b-q4", status: "idle" }),
      expect.objectContaining({ id: "qwen3.5-35b-a3b-q4", recommendedMemoryGb: 32 }),
      expect.objectContaining({ id: "gemma-4-e2b-it-q4", maxContextTokens: 131072 }),
      expect.objectContaining({ id: "gemma-4-31b-it-q4", maxContextTokens: 262144 }),
    ]));
  });

  it("uploads session-scoped images and serves them through the WebUI proxy", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const form = new FormData();
    form.set("session_id", "image-session");
    form.set("file", new Blob([png], { type: "image/png" }), "screen.png");

    const upload = await json(`${gateway.webUrl}/uploads`, { method: "POST", body: form });
    expect(upload.status).toBe(201);
    expect(upload.body.attachment).toMatchObject({
      name: "screen.png",
      mediaType: "image/png",
      size: png.length,
    });

    const image = await fetch(`${gateway.webUrl}${upload.body.attachment.url}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);

    const otherSession = new URL(upload.body.attachment.url, gateway.webUrl);
    otherSession.searchParams.set("session_id", "other-session");
    expect((await fetch(otherSession)).status).toBe(404);

    const record = readAttachment(workspacePath, "image-session", upload.body.attachment.id);
    expect(record).toBeDefined();
    appendSessionMessage(workspacePath, "image-session", {
      role: "user",
      content: [{ type: "text", text: "解释图片" }, attachmentToImageBlock(record!)],
    });
    const history = await json(`${gateway.webUrl}/history/sessions/image-session/messages`);
    expect(history.body.messages).toContainEqual(expect.objectContaining({
      role: "user",
      text: "解释图片",
      attachments: [expect.objectContaining({
        id: upload.body.attachment.id,
        name: "screen.png",
        mediaType: "image/png",
      })],
    }));
  });

  it("rejects image uploads whose declared type does not match their signature", async () => {
    const form = new FormData();
    form.set("session_id", "image-session");
    form.set("file", new Blob([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    ], { type: "image/jpeg" }), "fake.jpg");

    const upload = await json(`${gateway.apiUrl}/uploads`, { method: "POST", body: form });
    expect(upload).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining("MIME 类型不一致") },
    });
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
    expect(events.at(-1)?.data.text).toContain("- `/approve-all <审批 ID>`：允许当前对话轮次的全部权限申请");
  });

  it("exposes registered chat commands through the API and WebUI proxy", async () => {
    const direct = await json(`${gateway.apiUrl}/commands`);
    const proxied = await json(`${gateway.webUrl}/commands`);

    expect(direct.status).toBe(200);
    expect(direct.body.commands).toContainEqual({
      name: "help",
      aliases: [],
      description: "列出可用聊天命令",
      usage: "/help [命令名]",
    });
    expect(direct.body.commands).toContainEqual({
      name: "new",
      aliases: ["reset"],
      description: "开启一个新会话",
      usage: "/new",
    });
    expect(proxied).toEqual(direct);
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
    expect((await json(`${gateway.apiUrl}/approvals/missing/approve-turn-and-resume`, { method: "POST" })).status).toBe(404);
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
