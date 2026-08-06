import type { Plugin } from "../types.js";
import { buildProjectPrompt, getProjectLimits, inspectProject, readProjectDiff, readProjectGitStatus } from "../../project.js";
import { loadConfig } from "../../config.js";

export const coreProjectPlugin: Plugin = {
  name: "core-project",
  async init(ctx) {
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
        return `${prompt}\n\n${buildProjectPrompt(await inspectProject(root))}`;
      },
    });
  },
};
