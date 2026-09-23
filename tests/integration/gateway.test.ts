import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";
import { startTestGateway, type TestGateway } from "../helpers/start-gateway.js";
import { loadSessionState, saveSessionState } from "../../src/session-state.js";
import { appendSessionMessage, readSessionMeta } from "../../src/session-store.js";
import { attachmentToImageBlock, readAttachment } from "../../src/attachments.js";
import { createSessionPlan, markCurrentPlanStep, resumeSessionPlan, updateSessionPlanStep } from "../../src/plan-store.js";
import { createServer } from "node:http";
import { startRun, updateRun } from "../../src/run-store.js";
import { requestApproval, attachApprovalContinuation } from "../../src/tools/approval.js";

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

  it("projects large results in history and serves the exact original through the web proxy", async () => {
    const original = JSON.stringify({ results: [{ title: "paper", url: "https://example.com", snippet: "资料".repeat(30000) }] });
    await appendSessionMessage(workspacePath, "tool-original", { role: "assistant", content: [{ type: "tool_use", id: "large-call", name: "web_search", input: {} }] });
    await appendSessionMessage(workspacePath, "tool-original", { role: "user", content: [{ type: "tool_result", tool_use_id: "large-call", content: original }] });
    const history = await json(`${gateway.apiUrl}/history/sessions/tool-original/messages`);
    const result = JSON.parse(history.body.messages[0].toolCalls[0].result);
    expect(result.truncated).toBe(true);
    expect(result.results[0].snippet.length).toBeLessThanOrEqual(1500);
    const download = await fetch(`${gateway.webUrl}${result.originalUrl}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(await download.text()).toBe(original);
    expect((await fetch(`${gateway.webUrl}/tool-result?session_id=other&tool_call_id=large-call`)).status).toBe(404);
  });

  it("serves canonical defaults and removes obsolete settings on save without changing legacy protocol", async () => {
    const initial = await json(`${gateway.apiUrl}/config`);
    expect(initial.body.defaults).toMatchObject({ maxTokens: 16384, searchProvider: "duckduckgo", models: [{ id: "deepseek", provider: "openai-chat" }], defaultModelId: "deepseek" });
    expect(initial.body.config.modelProvider).toBe("anthropic-messages");
    const saved = await json(`${gateway.apiUrl}/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      ...initial.body.config, contextCompressionMaxChars: -1, historyWindowSize: 0,
      sessionSummary: { maxChars: 1, turnThreshold: 1, recentTurns: 5 }, plan: { maxGateCorrections: -1, maxSteps: 12 },
      profile: { enabled: false, maxItemChars: 4000, maxTotalChars: 10000 },
    }) });
    expect(saved.status).toBe(200);
    expect(saved.body.config.sessionSummary).toEqual({});
    expect(saved.body.config.plan).toEqual({ maxSteps: 12 });
    expect(saved.body.config.modelProvider).toBe("anthropic-messages");
    expect(saved.body.config).not.toHaveProperty("historyWindowSize");
    const disk = JSON.parse(readFileSync(resolve(workspacePath, "config.json"), "utf8"));
    expect(disk).not.toHaveProperty("contextCompressionMaxChars");
    expect(disk.profile.enabled).toBe(false);
  });

  it("restores pending questions through the web proxy and rejects duplicate or late answers", async () => {
    const model = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"answer received"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    try {
      const port = (model.address() as { port: number }).port;
      await json(`${gateway.apiUrl}/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiUrl: `http://127.0.0.1:${port}/v1`, modelProvider: "openai-chat", autoMemory: { enabled: false }, sessionSummary: { enabled: false } }) });
      const call = { type: "tool_use" as const, id: "ask-http", name: "ask_user", input: { question: "Which?", type: "single_choice", options: [{ id: "a", label: "A" }] } };
      await appendSessionMessage(workspacePath, "question-http", { role: "user", content: "start", _turnId: "question-turn" });
      await appendSessionMessage(workspacePath, "question-http", { role: "assistant", content: [{ type: "text", text: "before question" }, call], _turnId: "question-turn" });
      startRun(workspacePath, "question-http", "question-turn", "normal");
      updateRun(workspacePath, "question-http", "question-turn", { state: "waiting_user", suspension: { id: "question-http-id", kind: "user_input", payload: { ...call.input, maxAnswerChars: 12000 }, status: "pending", toolCall: call, skippedToolCalls: [], iteration: 1 } });
      const history = await json(`${gateway.webUrl}/history/sessions/question-http/messages`);
      expect(JSON.stringify(history.body)).toContain("waiting_user");
      const sessions = await json(`${gateway.webUrl}/history/sessions`);
      expect(sessions.body.sessions.find((session: { id: string }) => session.id === "question-http")).toMatchObject({ busy: false, attention: "input" });
      const post = (selectedIds: string[]) => fetch(`${gateway.webUrl}/user-input/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: "question-http", request_id: "question-http-id", selectedIds }) });
      const invalid = await post(["unknown"]);
      expect(invalid.status).toBe(400);
      await invalid.text();
      const responses = await Promise.all([post(["a"]), post(["a"])]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const texts = await Promise.all(responses.map((response) => response.text()));
      expect(texts.find((text) => text.includes("event: done"))).toContain("answer received");
      const stream = texts.find(text => text.includes("event: done"))!;
      const payloads = stream.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      expect(payloads.find(item => item.textMode === "full-turn")).toMatchObject({ turnId: "question-turn", text: "before question\n" });
      expect(payloads.some(item => item.text === "before question\nanswer received")).toBe(true);
      const final = await json(`${gateway.webUrl}/history/sessions/question-http/messages`);
      expect(JSON.stringify(final.body)).toContain("selectedOptions");
    } finally { await new Promise<void>((resolve) => model.close(() => resolve())); }
  });

  it("keeps a disconnected task running and reconnects through the web proxy", async () => {
    let finishModel!: () => void;
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => { started = resolve; });
    const model = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n`);
      finishModel = () => {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " second" } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      };
      started();
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const address = model.address() as { port: number };
    const controller = new AbortController();
    try {
      const config = await json(`${gateway.apiUrl}/config`);
      await json(`${gateway.apiUrl}/config`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...config.body.config,
          models: (config.body.config.models as Array<Record<string, unknown>>).map((item) => ({ ...item, provider: "openai-chat", apiUrl: `http://127.0.0.1:${address.port}` })),
        }),
      });
      const created = await json(`${gateway.apiUrl}/sessions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "chat" }),
      });
      const sessionId = created.body.session.id;
      const response = await fetch(`${gateway.webUrl}/chat`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, message: "run", turn_id: "11111111-1111-4111-8111-111111111111" }), signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let initial = "";
      while (!initial.includes('"text":"first"')) initial += decoder.decode((await reader.read()).value);
      await modelStarted;
      controller.abort();
      const resumed = await fetch(`${gateway.webUrl}/sessions/${sessionId}/events`);
      expect(resumed.status).toBe(200);
      const resumedReader = resumed.body!.getReader();
      let output = decoder.decode((await resumedReader.read()).value);
      expect(output).toContain('"text":"first"');
      expect(output).toContain("event: snapshot");
      expect((await json(`${gateway.apiUrl}/history/sessions`)).body.sessions.find((item: { id: string }) => item.id === sessionId).busy).toBe(true);
      finishModel();
      for (;;) {
        const next = await resumedReader.read();
        if (next.done) break;
        output += decoder.decode(next.value);
      }
      expect(output).toContain('"text":" second"');
      expect(output).toContain("event: done");
      expect((await fetch(`${gateway.webUrl}/sessions/${sessionId}/events`)).status).toBe(204);
    } finally {
      controller.abort();
      finishModel?.();
      model.closeAllConnections();
      await new Promise<void>((resolve) => model.close(() => resolve()));
    }
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
      models: [{ id: "remote", apiKey: "test-api-key" }],
      ollamaApiKey: "ollama-secret",
      plugins: {
        demo: {
          appSecret: "plugin-secret",
          verificationToken: "plugin-token",
        },
      },
    });
  });

  it("exposes plugin metadata and safely updates declared plugin config", async () => {
    await gateway.stop();
    const pluginDir = resolve(workspacePath, "plugins", "configured");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(resolve(pluginDir, "index.ts"), `
      export default {
        manifest: {
          id: "configured",
          version: "1.0.0",
          kind: "workspace",
          description: "Configured plugin",
          config: { fields: {
            endpoint: { type: "string", title: "Endpoint", required: true },
            token: { type: "string", title: "Token", required: true, secret: true }
          } },
          permissions: { tools: ["configured_tool"] }
        },
        setup(ctx) {
          ctx.registerTool({ name: "configured_tool", description: "test", inputSchema: { type: "object", properties: {} } });
        }
      };
    `, "utf-8");
    const configPath = resolve(workspacePath, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.plugins.configured = { endpoint: "https://old.example", token: "private-token" };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    gateway = await startTestGateway(workspacePath);

    const list = await json(`${gateway.apiUrl}/plugins`);
    expect(list.status).toBe(200);
    expect(list.body.plugins).toContainEqual(expect.objectContaining({ id: "configured", state: "active" }));

    const before = await json(`${gateway.apiUrl}/plugins/configured/config`);
    expect(before.body).toMatchObject({ config: { endpoint: "https://old.example", token: "priv***" }, valid: true });

    const saved = await json(`${gateway.apiUrl}/plugins/configured/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "https://new.example", token: "priv***" }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.plugin).toMatchObject({ id: "configured", state: "active" });
    expect(JSON.parse(readFileSync(configPath, "utf-8")).plugins.configured).toEqual({
      endpoint: "https://new.example",
      token: "private-token",
    });

    const invalid = await json(`${gateway.apiUrl}/plugins/configured/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: 1, token: "private-token" }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.issues).toContainEqual(expect.objectContaining({ path: "endpoint", severity: "error" }));

    const disabled = await json(`${gateway.apiUrl}/plugins/configured/state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.plugin).toMatchObject({ id: "configured", enabled: false, state: "stopped" });
    expect(JSON.parse(readFileSync(configPath, "utf-8")).pluginStates.configured).toEqual({ enabled: false });

    await gateway.stop();
    gateway = await startTestGateway(workspacePath);
    const afterRestart = await json(`${gateway.apiUrl}/plugins`);
    expect(afterRestart.body.plugins).toContainEqual(expect.objectContaining({
      id: "configured",
      enabled: false,
    }));

    const enabled = await json(`${gateway.apiUrl}/plugins/configured/state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.plugin).toMatchObject({ id: "configured", enabled: true, state: "active" });
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
      busy: false,
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
    await appendSessionMessage(workspacePath, created.body.session.id, { role: "user", content: "第一轮", _timestamp: 1, _turnId: firstTurnId });
    await appendSessionMessage(workspacePath, created.body.session.id, { role: "assistant", content: "第一轮结果", _timestamp: 2, _turnId: firstTurnId });
    await appendSessionMessage(workspacePath, created.body.session.id, { role: "user", content: "第二轮", _timestamp: 3, _turnId: secondTurnId });
    await appendSessionMessage(workspacePath, created.body.session.id, { role: "assistant", content: "第二轮结果", _timestamp: 4, _turnId: secondTurnId });
    const response = await json(`${gateway.webUrl}/plan?session_id=${encodeURIComponent(created.body.session.id)}`);
    expect(response).toEqual({ status: 200, body: { plans: [firstPlan, secondPlan], activePlan: null } });
    const history = await json(`${gateway.webUrl}/history/sessions/${encodeURIComponent(created.body.session.id)}/messages`);
    expect(history.body.messages).toEqual([
      expect.objectContaining({ role: "user", turnId: firstTurnId }),
      expect.objectContaining({ role: "assistant", turnId: firstTurnId, plan: firstPlan }),
      expect.objectContaining({ role: "user", turnId: secondTurnId }),
      expect.objectContaining({ role: "assistant", turnId: secondTurnId, plan: secondPlan }),
    ]);
  });

  it("keeps paused and resumed plans in their related history turns without restoring a stale active plan", async () => {
    const created = await json(`${gateway.apiUrl}/sessions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "chat" }),
    });
    const sessionId = created.body.session.id;
    const original = createSessionPlan(workspacePath, sessionId, "initial", ["确认", "执行"], "确认并执行任务");
    updateSessionPlanStep(workspacePath, sessionId, "initial", "step-1", "in_progress");
    updateSessionPlanStep(workspacePath, sessionId, "initial", "step-1", "waiting_user");
    const plan = resumeSessionPlan(workspacePath, sessionId, "continued", original.id);
    for (const turnId of ["initial", "unrelated", "continued"]) {
      await appendSessionMessage(workspacePath, sessionId, { role: "user", content: turnId, _turnId: turnId });
      await appendSessionMessage(workspacePath, sessionId, { role: "assistant", content: `回答 ${turnId}`, _turnId: turnId });
    }
    const history = await json(`${gateway.webUrl}/history/sessions/${sessionId}/messages`);
    expect(history.body.messages.filter((message: { plan?: unknown }) => message.plan)).toEqual([
      expect.objectContaining({ turnId: "initial", plan }),
      expect.objectContaining({ turnId: "continued", plan }),
    ]);
    expect((await json(`${gateway.webUrl}/plan?session_id=${sessionId}`)).body).toEqual({ plans: [plan], activePlan: null });
    startRun(workspacePath, sessionId, "continued", "plan");
    updateRun(workspacePath, sessionId, "continued", { state: "interrupted", reason: "门禁拦截，未执行" });
    for (let i = 0; i < 2; i++) {
      const restored = await json(`${gateway.webUrl}/history/sessions/${sessionId}/messages`);
      const message = restored.body.messages.find((item: { role: string; turnId?: string }) => item.role === "assistant" && item.turnId === "continued");
      expect(message.runState).toBe("interrupted");
      expect(message.text.match(/本轮已中断/g)).toHaveLength(1);
    }
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

  it("lists models and switches a session model", async () => {
    const modelsResponse = await json(`${gateway.apiUrl}/models`);
    expect(modelsResponse.status).toBe(200);
    expect(modelsResponse.body.models).toContainEqual(expect.objectContaining({ id: "remote", provider: "anthropic-messages" }));
    expect(modelsResponse.body.defaultModelId).toBe("remote");

    const created = await json(`${gateway.apiUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "chat" }),
    });
    const sessionId = created.body.session.id as string;

    const switched = await json(`${gateway.apiUrl}/sessions/${sessionId}/model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "remote" }),
    });
    expect(switched).toEqual({ status: 200, body: { id: "remote", name: "远程模型" } });

    const sessions = await json(`${gateway.apiUrl}/history/sessions`);
    expect(sessions.body.sessions).toContainEqual(expect.objectContaining({ id: sessionId, currentModelId: "remote" }));
    expect(readSessionMeta(workspacePath, sessionId)?.currentModelId).toBe("remote");

    const missing = await json(`${gateway.apiUrl}/sessions/${sessionId}/model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "nope" }),
    });
    expect(missing).toEqual({ status: 404, body: { error: "模型 nope 不存在" } });
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
    expect(before).toContainEqual(expect.objectContaining({
      event: "error",
      data: expect.objectContaining({ message: "尚未配置模型 API Key，请先在配置页面填写并保存。" }),
    }));

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
      "tags: [breeze-coder]",
      "createdAt: 2026-06-02T00:00:00.000Z",
      "updatedAt: 2026-06-02T00:00:00.000Z",
      "disabled: false",
      "scope: project",
      "source: manual",
      "summary: 项目背景",
      "---",
      "",
      "breeze-coder project",
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
    await appendSessionMessage(workspacePath, "main", { role: "user", content: "main question", _timestamp: 2 });
    await appendSessionMessage(workspacePath, "main", { role: "assistant", content: "main answer", _timestamp: 3 });
    await appendSessionMessage(workspacePath, "sub:main:worker", { role: "user", content: "sub question", _timestamp: 4 });

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
    await appendSessionMessage(workspacePath, sessionId, { role: "user", content: "special question", _timestamp: 2 });
    await appendSessionMessage(workspacePath, sessionId, { role: "assistant", content: "special answer", _timestamp: 3 });

    expect((await json(`${gateway.apiUrl}/history/sessions`)).body.sessions.map((session: { id: string }) => session.id)).toEqual([sessionId]);

    const deleted = await json(`${gateway.apiUrl}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    expect(deleted.body).toEqual({ deleted: true, deletedHistoryRecords: 2, deletedSessionState: false });
    expect((await json(`${gateway.apiUrl}/history/sessions`)).body.sessions).toEqual([]);
  });

  it("proxies DELETE session requests without sending an empty body", async () => {
    const sessionId = "web-proxy-delete";
    await appendSessionMessage(workspacePath, sessionId, { role: "user", content: "delete through web proxy", _timestamp: 2 });

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
    await appendSessionMessage(workspacePath, "tool-history", { role: "user", content: "run pwd", _timestamp: 1 });
    await appendSessionMessage(workspacePath, "tool-history", {
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }],
      _timestamp: 2,
    });
    await appendSessionMessage(workspacePath, "tool-history", {
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

  it("projects persisted run and tool times into history after restart", async () => {
    const sessionId = "timed-history";
    const turnId = "timed-turn";
    appendSessionMessage(workspacePath, sessionId, { role: "assistant", _turnId: turnId,
      content: [{ type: "tool_use", id: "timed-call", name: "bash", input: { command: "test" } }] });
    appendSessionMessage(workspacePath, sessionId, { role: "user", _turnId: turnId,
      content: [{ type: "tool_result", tool_use_id: "timed-call", content: "ok" }] });
    const started = startRun(workspacePath, sessionId, turnId, "normal");
    const ended = updateRun(workspacePath, sessionId, turnId, { state: "completed", toolTimings: { "timed-call": { startedAt: 1000, completedAt: 6000 } } });
    await gateway.stop();
    gateway = await startTestGateway(workspacePath);
    const history = await json(`${gateway.apiUrl}/history/sessions/${sessionId}/messages`);
    expect(history.body.messages[0]).toMatchObject({
      run: { startedAt: started.startedAt, completedAt: ended?.completedAt, state: "completed" },
      toolCalls: [{ id: "timed-call", startedAt: 1000, completedAt: 6000, result: "ok" }],
    });
  });

  it("does not show an orphaned approval tool call as still running", async () => {
    const sessionId = "orphaned-approval";
    const turnId = "approval-turn";
    await appendSessionMessage(workspacePath, sessionId, {
      role: "assistant",
      content: [{ type: "tool_use", id: "call-orphaned", name: "bash", input: { command: "pwd" } }],
      _timestamp: 2,
      _turnId: turnId,
    });
    const plan = createSessionPlan(workspacePath, sessionId, turnId, ["运行命令", "检查结果"]);
    updateSessionPlanStep(workspacePath, sessionId, turnId, plan.steps[0].id, "in_progress");
    markCurrentPlanStep(workspacePath, sessionId, turnId, "waiting_approval");

    await json(`${gateway.apiUrl}/plan?session_id=${sessionId}`);
    const messages = (await json(`${gateway.apiUrl}/history/sessions/${sessionId}/messages`)).body.messages;
    expect(messages[0].toolCalls[0]).toEqual(expect.objectContaining({
      id: "call-orphaned",
      result: JSON.stringify({ status: "blocked", error: "审批上下文已过期或丢失，工具未执行" }),
    }));
  });

  it.each(["plan", "normal"] as const)("restores an interrupted tool independently of plan steps (%s)", async (mode) => {
    const sessionId = `expired-${mode}`;
    const turnId = "expired-turn";
    await appendSessionMessage(workspacePath, sessionId, {
      role: "assistant",
      content: [{ type: "tool_use", id: "expired-call", name: "bash", input: { command: "npm test" } }],
      _turnId: turnId,
    });
    if (mode === "plan") {
      const plan = createSessionPlan(workspacePath, sessionId, turnId, ["运行评测"]);
      updateSessionPlanStep(workspacePath, sessionId, turnId, plan.steps[0].id, "in_progress");
    }
    startRun(workspacePath, sessionId, turnId, mode);
    updateRun(workspacePath, sessionId, turnId, {
      state: "interrupted", pendingToolCallId: "expired-call", reason: "审批已过期或丢失，请核实操作结果后重新发起",
    });
    for (let i = 0; i < 2; i++) {
      const messages = (await json(`${gateway.apiUrl}/history/sessions/${sessionId}/messages`)).body.messages;
      expect(messages[0]).toMatchObject({ runState: "interrupted", toolCalls: [{
        id: "expired-call", status: "interrupted", statusReason: "审批已过期或丢失，请核实操作结果后重新发起",
      }] });
      expect(messages[0].toolCalls[0].result).toBeUndefined();
    }
  });

  it("reads and updates project trust through the project plugin", async () => {
    const root = createTempWorkspace();
    const request = (method: string, body: unknown) => json(`${gateway.apiUrl}/projects/settings`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    try {
      expect((await request("POST", { path: root })).body.trusted).toBe(false);
      expect((await request("PUT", { path: root, trusted: "true" })).status).toBe(400);
      expect((await request("PUT", { path: root, trusted: true })).body.trusted).toBe(true);
      expect((await request("POST", { path: root })).body.trusted).toBe(true);
      expect((await request("PUT", { path: root, trusted: false })).body.trusted).toBe(false);
    } finally { removeTempWorkspace(root); }
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
    await appendSessionMessage(workspacePath, "image-session", {
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
    await appendSessionMessage(workspacePath, "ctx-session", { role: "user", content: "hello context", _timestamp: 1 });
    await appendSessionMessage(workspacePath, "ctx-session", { role: "assistant", content: [{ type: "text", text: "context reply" }], _timestamp: 2 });

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

  it("retains expired approvals across restart, renews without execution, and allows cancellation", async () => {
    const sessionId = "renew-expired";
    const turnId = "renew-turn";
    const toolCall = { type: "tool_use" as const, id: "renew-call", name: "bash", input: { command: "echo must-not-run" } };
    appendSessionMessage(workspacePath, sessionId, { role: "assistant", content: [toolCall], _turnId: turnId });
    const approval = requestApproval(workspacePath, "bash", toolCall.input, -1, undefined, sessionId).approval!;
    attachApprovalContinuation(workspacePath, approval.id, { toolCall, skippedToolCalls: [], iteration: 0, executionMode: "normal", turnId });
    startRun(workspacePath, sessionId, turnId, "normal");
    updateRun(workspacePath, sessionId, turnId, { state: "waiting_approval", approvalId: approval.id });
    await gateway.stop();
    gateway = await startTestGateway(workspacePath);
    const history = await json(`${gateway.apiUrl}/history/sessions/${sessionId}/messages`);
    expect(JSON.parse(history.body.messages[0].toolCalls[0].result)).toMatchObject({ approvalStatus: "expired", expiresAt: approval.expiresAt });
    expect((await json(`${gateway.apiUrl}/approvals/${approval.id}/approve`, { method: "POST" })).status).toBe(404);
    const renewed = await json(`${gateway.webUrl}/approvals/${approval.id}/renew`, { method: "POST" });
    expect(renewed.status).toBe(200);
    expect(renewed.body.approval.status).toBe("pending");
    expect(Date.parse(renewed.body.approval.expiresAt)).toBeGreaterThan(Date.now() + 86_000_000);
    expect((await json(`${gateway.apiUrl}/approvals/${approval.id}/renew`, { method: "POST" })).status).toBe(409);
    const plan = await json(`${gateway.apiUrl}/plan?session_id=${sessionId}`);
    expect(plan.body.run.state).toBe("waiting_approval");
    expect((await json(`${gateway.apiUrl}/history/sessions/${sessionId}/messages`)).body.messages).toHaveLength(1);
    expect((await json(`${gateway.apiUrl}/sessions/${sessionId}/cancel`, { method: "POST" })).status).toBe(200);
    expect((await json(`${gateway.apiUrl}/approvals`)).body.approvals).toEqual([]);
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
