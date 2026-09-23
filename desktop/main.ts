import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  handleDesktopWindowClose,
  shouldQuitWhenAllWindowsClosed,
  showDesktopWindow,
} from "./window-lifecycle.js";
import { createLoadingPageUrl } from "./loading-page.js";
import { desktopUserDataPath, initializeDesktopWorkspace } from "./workspace.js";
import { selectProjectDirectory } from "./directory-picker.js";
import { stopDesktopGateway } from "./gateway-lifecycle.js";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let gatewayProcess: ChildProcess | null = null;
let quitting = false;

ipcMain.handle("project:select-directory", async (event) => {
  const window = mainWindow;
  if (!window || event.sender !== window.webContents) {
    throw new Error("无效的目录选择请求");
  }
  return selectProjectDirectory(() => dialog.showOpenDialog(window, {
    title: "选择项目目录",
    properties: ["openDirectory", "createDirectory"],
  }));
});

function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配本地端口"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForGateway(url: string, child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Gateway 启动失败，退出码 ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Gateway 尚未监听，继续等待。
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Gateway 启动超时");
}

async function stopGateway(): Promise<void> {
  const child = gatewayProcess;
  gatewayProcess = null;
  if (!child || child.exitCode !== null) return;

  await stopDesktopGateway(child, 3_000);
}

async function createTray(): Promise<void> {
  const iconPath = app.isPackaged
    ? resolve(process.resourcesPath, process.platform === "darwin" ? "trayTemplate.png" : "loading-logo.png")
    : resolve(app.getAppPath(), process.platform === "darwin" ? "build/trayTemplate.png" : "build/icon.png");
  const trayIcon = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin") trayIcon.setTemplateImage(true);
  tray = new Tray(process.platform === "win32" ? trayIcon.resize({ width: 32, height: 32 }) : trayIcon);
  tray.setToolTip("Breeze Coder");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "打开 Breeze Coder",
      click: () => showDesktopWindow(mainWindow),
    },
    { type: "separator" },
    {
      label: "退出 Breeze Coder",
      click: () => app.quit(),
    },
  ]));
  tray.on("click", () => showDesktopWindow(mainWindow));
}

async function launchDesktop(): Promise<void> {
  const workspacePath = initializeDesktopWorkspace(app.getPath("userData"));
  const [apiPort, webPort] = await Promise.all([reservePort(), reservePort()]);
  const appRoot = app.getAppPath();
  const logoPath = app.isPackaged ? resolve(process.resourcesPath, "loading-logo.png") : resolve(appRoot, "build/icon.png");
  const tsxCli = resolve(appRoot, "node_modules/tsx/dist/cli.mjs");
  const gatewayEntry = resolve(appRoot, "dist/gateway.js");
  const webUrl = `http://127.0.0.1:${webPort}/`;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    title: "Breeze Coder",
    icon: logoPath,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111113" : "#f7f7f5",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
    },
  });

  const window = mainWindow;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(webUrl) && !url.startsWith("data:text/html")) event.preventDefault();
  });
  window.on("close", (event) => {
    handleDesktopWindowClose(event, window, quitting);
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  const logoDataUrl = nativeImage.createFromPath(logoPath).toDataURL();
  await Promise.all([
    window.loadURL(createLoadingPageUrl(logoDataUrl)),
    createTray(),
  ]);

  gatewayProcess = spawn(
    process.execPath,
    [
      tsxCli,
      gatewayEntry,
      "--daemon-child",
      "--host",
      "127.0.0.1",
      "--port",
      String(apiPort),
      "--web-port",
      String(webPort),
      "--workspace",
      workspacePath,
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );

  gatewayProcess.stdout?.on("data", (chunk) => console.log(`[gateway] ${String(chunk).trimEnd()}`));
  gatewayProcess.stderr?.on("data", (chunk) => console.error(`[gateway] ${String(chunk).trimEnd()}`));
  gatewayProcess.once("exit", (code, signal) => {
    gatewayProcess = null;
    if (!quitting) {
      void dialog.showErrorBox("Breeze Coder Gateway 已停止", `退出码：${code ?? "无"}\n信号：${signal ?? "无"}`);
    }
  });

  await waitForGateway(webUrl, gatewayProcess);
  await window.loadURL(webUrl);
}

// An explicit data directory also permits isolated packaged-app smoke tests.
const userDataDirectory = app.commandLine.getSwitchValue("user-data-dir");
app.setPath("userData", desktopUserDataPath(app.getPath("appData"), userDataDirectory));
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showDesktopWindow(mainWindow);
  });

  app.whenReady()
    .then(() => {
      if (process.platform === "win32") app.setAppUserModelId("com.lihongxun.breeze-coder");
      return launchDesktop();
    })
    .catch((error) => {
      dialog.showErrorBox("Breeze Coder 启动失败", error instanceof Error ? error.message : String(error));
      app.quit();
    });

  app.on("activate", () => {
    showDesktopWindow(mainWindow);
  });

  app.on("window-all-closed", () => {
    if (shouldQuitWhenAllWindowsClosed(process.platform)) app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    if (!gatewayProcess) return;
    event.preventDefault();
    void stopGateway().catch(error => console.error("Gateway shutdown failed", error)).finally(() => app.quit());
  });
}
