import type { Plugin } from "../types.js";
import { buildProjectPrompt, getProjectLimits, inspectProject, readProjectDiff, readProjectGitStatus } from "../../project.js";
import { loadConfig } from "../../config.js";
import { isTrustedProject, projectTempDirectory, setProjectTrust } from "../../security/project-trust.js";

export const coreProjectPlugin: Plugin = {
  name: "core-project",
  async init(ctx) {
    for (const method of ["POST", "PUT"] as const) {
      ctx.registerRoute({ method, path: "/projects/settings", async handler(_req, _res, routeCtx) {
        try {
          const body = JSON.parse(await routeCtx.readBody()) as { path?: unknown; trusted?: unknown };
          if (typeof body.path !== "string" || !body.path.trim()) throw new Error("缺少项目路径");
          const project = await inspectProject(body.path);
          if (method === "PUT") {
            if (typeof body.trusted !== "boolean") throw new Error("trusted 必须为布尔值");
            setProjectTrust(ctx.workspacePath, project.root, body.trusted);
          }
          routeCtx.sendJSON(200, { root: project.root, trusted: isTrustedProject(loadConfig(ctx.workspacePath), project.root, ctx.workspacePath) });
        } catch (error) {
          routeCtx.sendJSON(400, { error: error instanceof Error ? error.message : String(error) });
        }
      } });
    }
    ctx.registerRoute({
      method: "POST",
      path: "/projects/inspect",
      async handler(_req, _res, routeCtx) {
        try {
          const body = JSON.parse(await routeCtx.readBody()) as { path?: unknown };
          if (typeof body.path !== "string" || !body.path.trim()) {
            routeCtx.sendJSON(400, { error: "缺少项目路径" });
            return;
          }
          routeCtx.sendJSON(200, { project: await inspectProject(body.path) });
        } catch (error) {
          routeCtx.sendJSON(400, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    });

    ctx.registerRoute({
      method: "POST",
      path: "/projects/status",
      async handler(_req, _res, routeCtx) {
        try {
          const body = JSON.parse(await routeCtx.readBody()) as { path?: unknown };
          if (typeof body.path !== "string" || !body.path.trim()) throw new Error("缺少项目路径");
          const limits = getProjectLimits(loadConfig(ctx.workspacePath));
          routeCtx.sendJSON(200, { status: await readProjectGitStatus(body.path, limits.gitTimeoutMs) });
        } catch (error) {
          routeCtx.sendJSON(400, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    });

    ctx.registerRoute({
      method: "POST",
      path: "/projects/diff",
      async handler(_req, _res, routeCtx) {
        try {
          const body = JSON.parse(await routeCtx.readBody()) as { path?: unknown; file?: unknown };
          if (typeof body.path !== "string" || !body.path.trim()) throw new Error("缺少项目路径");
          if (typeof body.file !== "string" || !body.file.trim()) throw new Error("缺少变更文件路径");
          const limits = getProjectLimits(loadConfig(ctx.workspacePath));
          routeCtx.sendJSON(200, { diff: await readProjectDiff(body.path, body.file, limits.gitTimeoutMs, limits.diffMaxChars) });
        } catch (error) {
          routeCtx.sendJSON(400, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    });

    ctx.registerHooks({
      async onBuildPrompt(hookCtx, prompt) {
        const root = hookCtx.sessionContext.project?.root;
        if (!root) return prompt;
        const trusted = isTrustedProject(hookCtx.config, root, ctx.workspacePath);
        const execution = trusted
          ? `用户已授权信任此项目代码。临时日志请写入 $TMPDIR（${projectTempDirectory(ctx.workspacePath, root)}）；系统修改和范围外写入仍需审批。`
          : "自动审批模式下，明确的项目内脚本、测试和构建默认允许执行，无需额外信任；内联代码、未知命令、系统修改和范围外写入仍需审批。每次审批模式保持不变。";
        return `${prompt}\n\n${buildProjectPrompt(await inspectProject(root))}\n${execution}\n长任务使用 background_start 启动，通过 background_status 查看日志、background_stop 终止；不要使用 nohup 或 & 绕开任务管理。`;
      },
    });
  },
};
