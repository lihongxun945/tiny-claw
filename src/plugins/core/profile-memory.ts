import type { Plugin } from "../types.js";
import { loadConfig } from "../../config.js";
import { deleteProfile, formatProfilesForPrompt, getProfile, getProfileLimits, listProfiles, saveProfile } from "../../tools/profile.js";
import { deleteMemory, getMemoryRecord } from "../../tools/memory.js";

export const coreProfileMemoryPlugin: Plugin = {
  name: "core-profile-memory",
  async init(ctx) {
    const legacyUserName = getMemoryRecord(ctx.workspacePath, "user-name");
    if (legacyUserName && !getProfile(ctx.workspacePath, "communication")) {
      saveProfile(ctx.workspacePath, {
        name: "communication",
        summary: legacyUserName.summary,
        content: legacyUserName.content,
        disabled: legacyUserName.disabled,
        source: legacyUserName.source,
      }, getProfileLimits(loadConfig(ctx.workspacePath)));
      deleteMemory(ctx.workspacePath, "user-name");
      ctx.log("INFO", "已将旧记忆 user-name 迁移到 Profile communication");
    }

    ctx.registerHooks({
      onBuildTurnPrompt(_hookCtx, prompt) {
        if (_hookCtx.config.profile?.enabled === false) return prompt;
        try {
          const profile = formatProfilesForPrompt(ctx.workspacePath, _hookCtx.config.profile?.maxTotalChars ?? 8000);
          return profile ? `${prompt}\n\n## 用户 Profile\n${profile}` : prompt;
        } catch (error) {
          ctx.log("ERROR", `Profile 注入失败: ${error instanceof Error ? error.message : String(error)}`, _hookCtx.sessionId);
          return prompt;
        }
      },
    });

    ctx.registerRoute({ method: "GET", path: "/profile", async handler(_req, _res, routeCtx) { routeCtx.sendJSON(200, { profiles: listProfiles(ctx.workspacePath) }); } });
    ctx.registerRoute({
      method: "POST", path: "/profile/get", async handler(_req, _res, routeCtx) {
        const body = JSON.parse(await routeCtx.readBody()) as { name?: string };
        const profile = getProfile(ctx.workspacePath, String(body.name ?? ""));
        routeCtx.sendJSON(profile ? 200 : 404, profile ? { profile } : { error: "Profile 不存在" });
      },
    });
    ctx.registerRoute({
      method: "PUT", path: "/profile", async handler(_req, _res, routeCtx) {
        try {
          const body = JSON.parse(await routeCtx.readBody()) as { name?: string; content?: string; summary?: string; disabled?: boolean };
          const config = loadConfig(ctx.workspacePath);
          const profile = saveProfile(ctx.workspacePath, { name: String(body.name ?? ""), content: String(body.content ?? ""), summary: body.summary, disabled: body.disabled, source: "manual" }, getProfileLimits(config));
          routeCtx.sendJSON(200, { profile });
        } catch (error) { routeCtx.sendJSON(400, { error: error instanceof Error ? error.message : String(error) }); }
      },
    });
    ctx.registerRoute({
      method: "DELETE", path: "/profile", async handler(_req, _res, routeCtx) {
        const body = JSON.parse(await routeCtx.readBody()) as { name?: string };
        routeCtx.sendJSON(200, { deleted: deleteProfile(ctx.workspacePath, String(body.name ?? "")) });
      },
    });
  },
};
