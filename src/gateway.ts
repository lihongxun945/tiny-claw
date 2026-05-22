import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { AgentSession, type AgentEvent } from "./agent.js";
import { appendLog } from "./workspace/logger.js";
import { loadPlugins, destroyPlugins } from "./plugins/loader.js";
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

  const child = spawn(
    tsxBin,
    [process.argv[1]!, "--daemon-child", "--port", String(port), "--workspace", resolve(workspacePath)],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  console.log(`Gateway daemon 已启动 (PID: ${child.pid})`);
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

function getOrCreateSession(sessionId: string | undefined, wp?: string): AgentSession {
  const wp_ = wp || workspacePath;
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastActivity = Date.now();
    return session;
  }
  const id = sessionId || randomUUID();
  const session = new AgentSession(id, wp_);
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

// === 插件路由注册表 ===

const pluginRoutes: RegisteredRoute[] = [];

// === HTTP 服务器 ===

async function runServer(port: number, workspacePath: string): Promise<void> {
  // 加载插件
  const config = loadConfig(workspacePath);
  const plugins = await loadPlugins(
    {
      builtin: config.enabledPlugins,
      external: config.externalPlugins,
    },
    (pluginName) => ({
      config: config.plugins?.[pluginName] ?? {},
      workspacePath,
      registerRoute(route) {
        pluginRoutes.push({ ...route, pluginName });
      },
      getOrCreateSession(id, prefix) {
        const fullId = prefix ? `${prefix}:${id}` : id;
        return getOrCreateSession(fullId, workspacePath);
      },
      deleteSession(id) {
        return sessions.delete(id);
      },
      log(level, message, sessionId) {
        appendLog(workspacePath, level, `[plugin:${pluginName}] ${message}`, sessionId);
      },
    }),
  );

  const pidPath = getPidPath(workspacePath);
  const isDaemonChild = process.argv.includes("--daemon-child");
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
    for (const route of pluginRoutes) {
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

        const session = getOrCreateSession(sessionId, workspacePath);
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
      const list = Array.from(sessions.values()).map((s) => ({
        id: s.id,
        lastActivity: s.lastActivity,
      }));
      sendJSON(res, 200, { sessions: list });
      return;
    }

    // DELETE /sessions/:id
    if (req.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
      const id = url.pathname.slice("/sessions/".length);
      if (sessions.delete(id)) {
        sendJSON(res, 200, { deleted: true });
      } else {
        sendJSON(res, 404, { error: "会话不存在" });
      }
      return;
    }

    // 404
    sendJSON(res, 404, { error: "未找到路由" });
  });

  // 启动日志（在 listen 之前写入，daemon 模式下 console.log 不可见）
  if (isDaemonChild) {
    appendLog(workspacePath, "info", `Gateway daemon 已启动 (PID: ${process.pid})，监听端口 ${port}`);
    appendLog(workspacePath, "info", "路由: POST /chat | GET /sessions | DELETE /sessions/:id");
    if (pluginRoutes.length > 0) {
      for (const route of pluginRoutes) {
        appendLog(workspacePath, "info", `路由: ${route.method} ${route.path} [${route.pluginName}]`);
      }
    }
    appendLog(workspacePath, "info", `工作目录: ${workspacePath}`);
  } else {
    console.log(`tiny-claw gateway 已启动: http://localhost:${port}`);
    console.log(`  POST /chat           - 发送消息（SSE 流式响应）`);
    console.log(`  GET  /sessions       - 列出活跃会话`);
    console.log(`  DELETE /sessions/:id - 销毁会话`);
    for (const route of pluginRoutes) {
      console.log(`  ${route.method.padEnd(6)} ${route.path} [${route.pluginName}]`);
    }
    console.log(`工作目录: ${workspacePath}`);
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
    await destroyPlugins(plugins);
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
