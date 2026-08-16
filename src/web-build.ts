import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

type CommandRunner = typeof spawnSync;

export function ensureWebBuild(projectRoot: string, run: CommandRunner = spawnSync): boolean {
  const indexPath = resolve(projectRoot, "web/dist/index.html");
  if (existsSync(indexPath)) return false;

  console.log("WebUI 构建产物不存在，正在自动构建...");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = run(npmCommand, ["run", "web:build"], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(`WebUI 自动构建失败: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`WebUI 自动构建失败，退出码: ${result.status ?? "unknown"}`);
  }
  if (!existsSync(indexPath)) {
    throw new Error(`WebUI 自动构建完成，但未生成: ${indexPath}`);
  }

  console.log("WebUI 自动构建完成");
  return true;
}
