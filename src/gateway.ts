import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { AgentSession, type AgentEvent } from "./agent.js";
import { PluginManager } from "./plugin-manager.js";
import { appendLog } from "./workspace/logger.js";
import type { RegisteredRoute, RouteContext } from "./plugins/types.js";

const SESSION_TIMEOUT = 30 * 60 * 1000;

function parseWorkspaceArg(): string | undefined {
  const idx = process.argv.indexOf("--workspace");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

function parsePortArg(): number {
  const idx = process.argv.indexOf("--port");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return parseInt(process.argv[idx + 1], 10) || 3000;
  }
  const envPort = process.env.TINY_CLAW_PORT;
  if (envPort) return parseInt(envPort, 10) || 3000;
  return 3000;
}

function parseWebPortArg(): number | undefined {
  const idx = process.argv.indexOf("--web-port");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return parseInt(process.argv[idx + 1], 10) || undefined;
  }
  const envPort = process.env.TINY_CLAW_WEB_PORT;
  if (envPort) return parseInt(envPort, 10) || undefined;
  return undefined;
}

function parseCommand(): string {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  return arg || "start";
}

// === Daemon 管理 ===

function getPidPath(workspacePath: string): string {
  return resolve(workspacePath, "gateway.pid");
}

function daemonIsRunning(pidPath: string): number | false {
  if (!existsSync(pidPath)) return false;
  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return false;
  }
}

function startDaemon(port: number, workspacePath: string): void {
  const pidPath = getPidPath(workspacePath);
  const running = daemonIsRunning(pidPath);
  if (running !== false) {
    console.log(`Gateway 已在运行中 (PID: ${running})`);
    process.exit(0);
  }

  // 清除过期 PID 文件
  if (existsSync(pidPath)) unlinkSync(pidPath);

  // 找到 tsx 二进制路径来重新调用自己（因为 .ts 文件不能直接用 node 执行）
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const tsxBin = resolve(__dirname, "../node_modules/.bin/tsx");
  const webPort = parseWebPortArg() || port + 1;

  const args = [process.argv[1]!, "--daemon-child", "--port", String(port), "--web-port", String(webPort), "--workspace", resolve(workspacePath)];

  const child = spawn(tsxBin, args, { detached: true, stdio: "ignore" });
  child.unref();

  console.log(`Gateway daemon 已启动 (PID: ${child.pid})`);
  console.log(`  Gateway API: http://localhost:${port}`);
  console.log(`  Web UI:      http://localhost:${webPort}`);
  process.exit(0);
}

function stopDaemon(workspacePath: string): void {
  const pidPath = getPidPath(workspacePath);
  const running = daemonIsRunning(pidPath);
  if (running === false) {
    console.log("Gateway 未运行");
    return;
  }

  process.kill(running, "SIGTERM");

  // 等待进程退出（最多 3 秒）
  for (let i = 0; i < 30; i++) {
    try {
      // eslint-disable-next-line no-loop-func, @typescript-eslint/no-loop-func
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      process.kill(running, 0);
    } catch {
      // 进程已退出
      try { unlinkSync(pidPath); } catch { /* ignore */ }
      console.log("Gateway 已停止");
      return;
    }
  }

  // 超时强制杀死
  try {
    process.kill(running, "SIGKILL");
    unlinkSync(pidPath);
  } catch { /* ignore */ }
  console.log("Gateway 已停止");
}

function daemonStatus(workspacePath: string): void {
  const pidPath = getPidPath(workspacePath);
  const running = daemonIsRunning(pidPath);
  if (running === false) {
    if (existsSync(pidPath)) {
      console.log("Gateway 未运行（存在过期 PID 文件，已清理）");
      unlinkSync(pidPath);
    } else {
      console.log("Gateway 未运行");
    }
  } else {
    console.log(`Gateway 正在运行 (PID: ${running})`);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

type FormattedMessage = { role: string; text: string; toolCalls: Array<{ name: string; input: Record<string, unknown>; result?: string }>; timestamp: number };

function isSubAgentSessionId(id: string): boolean {
  return id.startsWith("sub:");
}

function buildMessageListFromMessages(msgs: Array<{ role: string; content: string | Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown>; content?: string }> }>): FormattedMessage[] {
  // 第一步：解析原始消息，将 tool_result 合并到前一条 assistant
  const parsed: FormattedMessage[] = [];
  for (const m of msgs) {
    if (typeof m.content === "string") {
      if (m.role === "assistant" || m.role === "user") {
        parsed.push({ role: m.role, text: m.content, toolCalls: [], timestamp: (m as any)._timestamp ?? 0 });
      }
      continue;
    }
    const blocks = m.content;
    let text = "";
    const toolCalls: FormattedMessage["toolCalls"] = [];
    for (const b of blocks) {
      if (b.type === "text" && b.text) text += b.text;
      else if (b.type === "tool_use") toolCalls.push({ name: b.name ?? "", input: b.input ?? {} });
      else if (b.type === "tool_result") {
        const tc = toolCalls.find((t) => t.result === undefined);
        if (tc) tc.result = b.content ?? "";
      }
    }
    // user 消息只有 tool_result → 合并到前一条 assistant
    if (m.role === "user" && !text && toolCalls.some((tc) => tc.result !== undefined)) {
      const lastAssistant = [...parsed].reverse().find((r) => r.role === "assistant");
      if (lastAssistant) {
        for (const tc of toolCalls) {
          const existing = lastAssistant.toolCalls.find((t) => t.name === tc.name && t.result === undefined);
          if (existing) existing.result = tc.result;
          else lastAssistant.toolCalls.push(tc);
        }
      }
      continue;
    }
    if (m.role === "assistant" || (m.role === "user" && text)) {
      parsed.push({ role: m.role, text, toolCalls, timestamp: (m as any)._timestamp ?? 0 });
    }
  }

  // 第二步：合并连续的 assistant 消息（Agent 多轮工具调用）
  const result: FormattedMessage[] = [];
  for (const m of parsed) {
    if (m.role === "assistant" && result.length > 0 && result[result.length - 1].role === "assistant") {
      const prev = result[result.length - 1];
      prev.toolCalls.push(...m.toolCalls);
      if (m.text) prev.text += (prev.text ? "\n" : "") + m.text;
    } else {
      result.push({ ...m, toolCalls: [...m.toolCalls] });
    }
  }
  return result;
}

function buildMessageListFromRecords(historyDir: string, sessionId: string): FormattedMessage[] {
  const rawMsgs: Array<{ role: string; content: unknown; _timestamp?: number }> = [];
  const files = readdirSync(historyDir).filter((f) => f.endsWith(".jsonl")).sort();
  for (const f of files) {
    const lines = readFileSync(resolve(historyDir, f), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record._session !== sessionId) continue;
        rawMsgs.push({ role: record.role, content: record.content, _timestamp: record._timestamp });
      } catch { /* skip */ }
    }
  }
  return buildMessageListFromMessages(rawMsgs as Array<{ role: string; content: string | Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown>; content?: string }> }>);
}

function deleteSessionHistory(workspacePath: string, sessionId: string): number {
  const historyDir = resolve(workspacePath, "history");
  if (!existsSync(historyDir)) return 0;

  let deleted = 0;
  const files = readdirSync(historyDir).filter((f) => f.endsWith(".jsonl"));
  for (const file of files) {
    const path = resolve(historyDir, file);
    const lines = readFileSync(path, "utf-8").split("\n");
    const kept: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record._session === sessionId) {
          deleted++;
          continue;
        }
      } catch {
        // 保留无法解析的行，避免误删历史。
      }
      kept.push(line);
    }

    writeFileSync(path, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf-8");
  }

  return deleted;
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function sendSSEHeader(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "access-control-allow-origin": "*",
  });
}

function sendSSE(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// === 会话管理 ===

const sessions = new Map<string, AgentSession>();
let workspacePath = "";
let globalPluginManager: PluginManager | null = null;

function getOrCreateSession(sessionId: string | undefined, wp?: string, pm?: PluginManager): AgentSession {
  const wp_ = wp || workspacePath;
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    return session;
  }
  const id = sessionId || randomUUID();
  const session = new AgentSession(id, wp_, pm || globalPluginManager!);
  sessions.set(id, session);
  return session;
}

function cleanupSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      sessions.delete(id);
    }
  }
}

setInterval(cleanupSessions, 5 * 60 * 1000);

// === HTTP 服务器 ===

async function runServer(port: number, workspacePath: string): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const isDaemonChild = process.argv.includes("--daemon-child");

  // Web UI 端口（默认 gateway 端口 +1）
  const webPort = parseWebPortArg() || port + 1;

  // 加载配置 + 初始化 PluginManager
  const config = loadConfig(workspacePath);
  const pm = new PluginManager(workspacePath);
  globalPluginManager = pm;
  pm.setPluginConfigs(config.plugins ?? {});
  await pm.loadCorePlugins();

  // 为用户插件设置 Session 工厂（Gateway 特有）
  pm.setSessionFactory({
    getOrCreateSession: (id, prefix) => getOrCreateSession(prefix ? `${prefix}:${id}` : id, workspacePath, pm),
    deleteSession: (id) => sessions.delete(id),
  });
  await pm.loadUserPlugins({
    builtinPlugins: config.enabledPlugins,
    externalPlugins: config.externalPlugins,
    pluginConfigs: config.plugins,
  });

  const pidPath = getPidPath(workspacePath);
  if (isDaemonChild) {
    writeFileSync(pidPath, String(process.pid));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    // 构建 RouteContext
    const routeCtx: RouteContext = {
      readBody: () => readBody(req),
      sendJSON: (status, data) => sendJSON(res, status, data),
    };

    // 插件路由（优先匹配）
    const allRoutes = pm.getRoutes();
    for (const route of allRoutes) {
      if (req.method === route.method && url.pathname === route.path) {
        try {
          await route.handler(req, res, routeCtx);
        } catch (err) {
          if (!res.headersSent) {
            sendJSON(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        return;
      }
    }

    // POST /chat
    if (req.method === "POST" && url.pathname === "/chat") {
      try {
        const body = JSON.parse(await readBody(req));
        const message = body.message as string;
        const sessionId = body.session_id as string | undefined;

        if (!message || typeof message !== "string") {
          sendJSON(res, 400, { error: "缺少 message 字段" });
          return;
        }

        const session = getOrCreateSession(sessionId, workspacePath, pm);
        sendSSEHeader(res);

        for await (const event of session.chat(message)) {
          switch (event.type) {
            case "text_delta":
              sendSSE(res, "text_delta", { text: event.text });
              break;
            case "tool_call":
              sendSSE(res, "tool_call", { name: event.name, input: event.input });
              break;
            case "tool_result":
              sendSSE(res, "tool_result", { name: event.name, result: event.result });
              break;
            case "done":
              sendSSE(res, "done", { text: event.text, session_id: session.id });
              break;
            case "error":
              sendSSE(res, "error", { message: event.message });
              break;
          }
        }

        res.end();
      } catch (err) {
        if (!res.headersSent) {
          sendJSON(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return;
    }

    // GET /sessions
    if (req.method === "GET" && url.pathname === "/sessions") {
      const list = Array.from(sessions.values())
        .filter((s) => !isSubAgentSessionId(s.id))
        .map((s) => ({
          id: s.id,
          lastActivity: s.lastActivity,
        }));
      sendJSON(res, 200, { sessions: list });
      return;
    }

    // DELETE /sessions/:id
    if (req.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
      const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
      const deletedActive = sessions.delete(id);
      const deletedHistoryRecords = deleteSessionHistory(workspacePath, id);
      if (deletedActive || deletedHistoryRecords > 0) {
        appendLog(workspacePath, "INFO", `会话已删除，历史记录 ${deletedHistoryRecords} 条`, id);
        sendJSON(res, 200, { deleted: true, deletedHistoryRecords });
      } else {
        sendJSON(res, 404, { error: "会话不存在" });
      }
      return;
    }

    // GET /sessions/:id/messages
    if (req.method === "GET" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/messages")) {
      const id = url.pathname.slice("/sessions/".length, -"/messages".length);
      const session = sessions.get(id);
      if (!session) {
        sendJSON(res, 404, { error: "会话不存在" });
        return;
      }
      const messages = buildMessageListFromMessages(session.getMessages());
      sendJSON(res, 200, { messages });
      return;
    }

    // GET /logs — 日志文件列表
    if (req.method === "GET" && url.pathname === "/logs") {
      const logsDir = resolve(workspacePath, "logs");
      if (!existsSync(logsDir)) {
        sendJSON(res, 200, { files: [] });
        return;
      }
      const files = readdirSync(logsDir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => ({ name: f, size: statSync(resolve(logsDir, f)).size }))
        .sort((a, b) => b.name.localeCompare(a.name));
      sendJSON(res, 200, { files });
      return;
    }

    // GET /logs/:date — 日志内容
    if (req.method === "GET" && url.pathname.startsWith("/logs/")) {
      const date = url.pathname.slice("/logs/".length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        sendJSON(res, 400, { error: "日期格式无效" });
        return;
      }
      const logPath = resolve(workspacePath, "logs", `${date}.log`);
      if (!existsSync(logPath)) {
        sendJSON(res, 404, { error: "日志文件不存在" });
        return;
      }
      const tail = Math.min(parseInt(url.searchParams.get("tail") ?? "200", 10), 2000) || 200;
      const content = readFileSync(logPath, "utf-8");
      const lines = content.split("\n").filter(Boolean).slice(-tail);
      sendJSON(res, 200, { date, lines });
      return;
    }

    // GET /config — 获取配置（apiKey 脱敏）
    if (req.method === "GET" && url.pathname === "/config") {
      const configPath = resolve(workspacePath, "config.json");
      if (!existsSync(configPath)) {
        sendJSON(res, 404, { error: "配置文件不存在" });
        return;
      }
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (raw.apiKey) raw.apiKey = raw.apiKey.slice(0, 4) + "***";
      sendJSON(res, 200, { config: raw });
      return;
    }

    // PUT /config — 更新配置
    if (req.method === "PUT" && url.pathname === "/config") {
      try {
        const configPath = resolve(workspacePath, "config.json");
        const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf-8")) : {};
        const updates = JSON.parse(await readBody(req));
        delete updates.apiKey;
        const merged = { ...existing, ...updates };
        writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
        merged.apiKey = (merged.apiKey ?? "").slice(0, 4) + "***";
        sendJSON(res, 200, { config: merged });
      } catch (err) {
        sendJSON(res, 500, { error: `更新配置失败: ${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }

    // GET /history/sessions — 从历史文件 + 活跃会话合并
    if (req.method === "GET" && url.pathname === "/history/sessions") {
      const sessionMap = new Map<string, { id: string; lastActivity: number; preview: string }>();

      // 从历史文件读取
      const historyDir = resolve(workspacePath, "history");
      if (existsSync(historyDir)) {
        const files = readdirSync(historyDir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
        for (const f of files.slice(0, 30)) {
          const lines = readFileSync(resolve(historyDir, f), "utf-8").split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const record = JSON.parse(line);
              const sid = record._session;
              if (!sid) continue;
              if (isSubAgentSessionId(sid)) continue;
              if (!sessionMap.has(sid)) {
                const preview = typeof record.content === "string"
                  ? record.content.slice(0, 60)
                  : Array.isArray(record.content) && record.content[0]?.text
                    ? record.content[0].text.slice(0, 60)
                    : "";
                sessionMap.set(sid, { id: sid, lastActivity: 0, preview });
              }
              const entry = sessionMap.get(sid)!;
              if (record.role === "user") {
                entry.lastActivity = Math.max(entry.lastActivity, record._timestamp || Date.parse(f.replace(".jsonl", "")) || 0);
              }
            } catch { /* skip malformed */ }
          }
        }
      }

      // 合并活跃会话（新创建的但还未写入历史文件的）
      for (const [id, session] of sessions) {
        if (isSubAgentSessionId(id)) continue;
        if (!sessionMap.has(id)) {
          sessionMap.set(id, { id, lastActivity: session.lastActivity, preview: "" });
        }
      }

      const result = Array.from(sessionMap.values()).sort((a, b) => b.lastActivity - a.lastActivity);
      sendJSON(res, 200, { sessions: result });
      return;
    }

    // GET /history/sessions/:id/messages — 读取指定会话的历史消息
    if (req.method === "GET" && url.pathname.startsWith("/history/sessions/") && url.pathname.endsWith("/messages")) {
      const id = decodeURIComponent(url.pathname.slice("/history/sessions/".length, -"/messages".length));
      const historyDir = resolve(workspacePath, "history");
      if (!existsSync(historyDir)) {
        sendJSON(res, 200, { messages: [] });
        return;
      }
      const messages = buildMessageListFromRecords(historyDir, id);
      sendJSON(res, 200, { messages });
      return;
    }

    // 404
    sendJSON(res, 404, { error: "未找到路由" });
  });

  // === Web UI 服务器 ===
  const webDistPath = resolve(__dirname, "../web/dist");
  const webDir = resolve(__dirname, "../web");
  const hasDist = existsSync(resolve(webDistPath, "index.html"));
  let webServer: ReturnType<typeof createServer> | null = null;
  let viteChild: ReturnType<typeof spawn> | null = null;

  if (hasDist) {
    // 生产模式：从 web/dist/ 提供静态文件 + 代理 API 请求到 gateway
    webServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${webPort}`);

      // 代理 API 请求到 gateway
      if (url.pathname === "/chat" || url.pathname === "/sessions" || url.pathname === "/logs" || url.pathname === "/config" || url.pathname === "/history/sessions" || url.pathname.match(/^\/(sessions|logs|history\/sessions)\/[^/]+/)) {
        try {
          const proxyRes = await fetch(`http://localhost:${port}${url.pathname}${url.search}`, {
            method: req.method,
            headers: { "content-type": req.headers["content-type"] ?? "application/json" },
            body: req.method !== "GET" && req.method !== "HEAD" ? await readBody(req) : undefined,
          });
          const contentType = proxyRes.headers.get("content-type") ?? "application/json";
          res.writeHead(proxyRes.status, {
            "content-type": contentType,
            "access-control-allow-origin": "*",
          });
          if (contentType.includes("text/event-stream")) {
            const reader = proxyRes.body!.getReader();
            const decoder = new TextDecoder();
            const pump = async () => {
              while (true) {
                const { done, value } = await reader.read();
                if (done) { res.end(); return; }
                res.write(decoder.decode(value, { stream: true }));
              }
            };
            pump().catch(() => res.end());
          } else {
            const body = await proxyRes.text();
            res.end(body);
          }
        } catch (err) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `代理请求失败: ${err instanceof Error ? err.message : String(err)}` }));
        }
        return;
      }

      // 静态文件
      let filePath = resolve(webDistPath, url.pathname.slice(1) || "index.html");

      if (!filePath.startsWith(webDistPath)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      if (existsSync(filePath) && statSync(filePath).isFile()) {
        const ext = filePath.split(".").pop()!;
        const mimeTypes: Record<string, string> = {
          html: "text/html", js: "application/javascript", css: "text/css",
          json: "application/json", png: "image/png", svg: "image/svg+xml",
          ico: "image/x-icon", woff2: "font/woff2", woff: "font/woff",
          ttf: "font/ttf",
        };
        res.writeHead(200, {
          "content-type": mimeTypes[ext] || "application/octet-stream",
          "cache-control": ext === "html" ? "no-cache" : "max-age=3600",
        });
        res.end(readFileSync(filePath));
        return;
      }

      // SPA fallback
      const indexPath = resolve(webDistPath, "index.html");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(readFileSync(indexPath));
    });
    webServer.listen(webPort);
  } else if (!isDaemonChild) {
    // 开发模式：启动 Vite dev server
    const viteBin = resolve(webDir, "node_modules/.bin/vite");
    if (existsSync(viteBin)) {
      viteChild = spawn(viteBin, ["--port", String(webPort), "--strictPort"], {
        cwd: webDir,
        stdio: "inherit",
        env: { ...process.env, TINY_CLAW_PORT: String(port) },
      });
      viteChild.on("error", (err) => {
        console.error(`Vite dev server 启动失败: ${err.message}`);
        viteChild = null;
      });
    }
  }

  // 启动日志
  if (isDaemonChild) {
    appendLog(workspacePath, "info", `Gateway daemon 已启动 (PID: ${process.pid})`);
    appendLog(workspacePath, "info", `Gateway API: http://localhost:${port}`);
    if (hasDist) appendLog(workspacePath, "info", `Web UI: http://localhost:${webPort}`);
    appendLog(workspacePath, "info", `工作目录: ${workspacePath}`);
  } else {
    console.log(`tiny-claw 已启动`);
    console.log(`  Gateway API: http://localhost:${port}`);
    console.log(`  Web UI:      http://localhost:${webPort}${!hasDist && viteChild ? " (dev)" : ""}`);
    console.log(`  工作目录:    ${workspacePath}`);
  }

  server.on("error", (err: NodeJS.ErrnoException) => {
    const msg = `Gateway 启动失败: ${err.code} - ${err.message}`;
    appendLog(workspacePath, "error", msg);
    console.error(msg);
    if (err.code === "EADDRINUSE") {
      try { unlinkSync(pidPath); } catch { /* ignore */ }
    }
    process.exit(1);
  });

  server.listen(port);

  // 优雅关闭
  const shutdown = async () => {
    const msg = "Gateway 正在关闭";
    console.log(`\n${msg}...`);
    appendLog(workspacePath, "info", msg);
    if (viteChild) viteChild.kill();
    if (webServer) webServer.close();
    await pm.destroy();
    server.close();
    if (isDaemonChild) {
      appendLog(workspacePath, "info", "Gateway 已停止");
      try { unlinkSync(pidPath); } catch { /* ignore */ }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const workspacePath = parseWorkspaceArg() || process.env.TINY_CLAW_WORKSPACE || process.cwd() + "/workspace";
  const port = parsePortArg();
  const command = parseCommand();

  switch (command) {
    case "stop":
      stopDaemon(workspacePath);
      break;
    case "status":
      daemonStatus(workspacePath);
      break;
    case "restart":
      stopDaemon(workspacePath);
      startDaemon(port, workspacePath);
      break;
    default:
      if (process.argv.includes("--daemon-child")) {
        await runServer(port, workspacePath);
      } else {
        startDaemon(port, workspacePath);
      }
  }
}

main();
