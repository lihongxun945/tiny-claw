import assert from "node:assert/strict";
import { _electron, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const windows = process.platform === "win32";
const bundle = resolve(process.argv[2] ?? (windows ? "release/win-unpacked" : "release/mac-arm64/tiny-claw.app/Contents"));
const executablePath = join(bundle, windows ? "tiny-claw.exe" : "MacOS/tiny-claw");
const appRoot = join(bundle, windows ? "resources/app" : "Resources/app");
const data = mkdtempSync(join(tmpdir(), "tiny-claw-desktop-smoke-"));
let electron;
try {
  await new Promise((resolveRun, reject) => {
    const child = spawn(executablePath, [resolve("scripts/packaged-runtime-smoke.mjs"), appRoot], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit", windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolveRun() : reject(new Error(`Packaged native smoke exited ${code}`)));
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = await _electron.launch({ executablePath, args: [`--user-data-dir=${data}`], env });
  const window = await electron.firstWindow();
  await window.waitForURL(/^http:\/\/127\.0\.0\.1:/);
  await window.waitForLoadState("domcontentloaded");
  await expect(window.locator("body")).toContainText("tiny-claw");
  assert.ok(JSON.parse(readFileSync(join(data, "workspace/config.json"), "utf8")));
  const pidRecord = readFileSync(join(data, "workspace/gateway.pid"), "utf8").trim();
  const gatewayPid = Number(pidRecord);
  assert.ok(Number.isInteger(gatewayPid) && gatewayPid > 0);
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await electron.evaluate(({ app }) => app.emit("second-instance", {}, [], ""));
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await electron.close();
  electron = undefined;
  assert.throws(() => process.kill(gatewayPid, 0), "Gateway must exit with the desktop app");
  console.log("Packaged desktop startup, workspace, tray lifecycle and shutdown passed");
} finally {
  await electron?.close();
  rmSync(data, { recursive: true, force: true });
}
