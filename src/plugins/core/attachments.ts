import type { Plugin } from "../types.js";
import { createReadStream, existsSync } from "node:fs";
import { readAttachment, resolveAttachmentPath, saveAttachment } from "../../attachments.js";
import { loadConfig } from "../../config.js";

export const coreAttachmentsPlugin: Plugin = {
  name: "core-attachments",
  async init(ctx) {
    ctx.registerRoute({
      method: "POST",
      path: "/uploads",
      async handler(req, _res, routeCtx) {
        const contentLength = Number(req.headers["content-length"] ?? 0);
        const config = loadConfig(ctx.workspacePath);
        const maxSize = config.attachments?.maxFileSize ?? 10 * 1024 * 1024;
        if (contentLength > maxSize + 1024 * 1024) {
          routeCtx.sendJSON(413, { error: `上传内容不能超过 ${maxSize} 字节` });
          return;
        }

        const request = new Request("http://localhost/uploads", {
          method: "POST",
          headers: req.headers as HeadersInit,
          body: req as unknown as BodyInit,
          duplex: "half",
        } as RequestInit);
        const form = await request.formData();
        const sessionId = form.get("session_id");
        const file = form.get("file");
        if (typeof sessionId !== "string" || !sessionId.trim()) {
          routeCtx.sendJSON(400, { error: "缺少 session_id 字段" });
          return;
        }
        if (!(file instanceof File)) {
          routeCtx.sendJSON(400, { error: "缺少图片文件" });
          return;
        }

        try {
          const record = saveAttachment(
            ctx.workspacePath,
            sessionId,
            file.name,
            file.type,
            Buffer.from(await file.arrayBuffer()),
            config.attachments,
          );
          routeCtx.sendJSON(201, {
            attachment: {
              id: record.id,
              name: record.name,
              mediaType: record.mediaType,
              size: record.size,
              url: `/uploads?id=${encodeURIComponent(record.id)}&session_id=${encodeURIComponent(sessionId)}`,
            },
          });
        } catch (error) {
          routeCtx.sendJSON(400, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    });

    ctx.registerRoute({
      method: "GET",
      path: "/uploads",
      async handler(_req, res, routeCtx) {
        const id = routeCtx.url.searchParams.get("id") ?? "";
        const sessionId = routeCtx.url.searchParams.get("session_id") ?? "";
        const record = readAttachment(ctx.workspacePath, sessionId, id);
        if (!record) {
          routeCtx.sendJSON(404, { error: "附件不存在" });
          return;
        }
        const path = resolveAttachmentPath(ctx.workspacePath, record.path);
        if (!existsSync(path)) {
          routeCtx.sendJSON(404, { error: "附件文件不存在" });
          return;
        }
        res.writeHead(200, {
          "content-type": record.mediaType,
          "content-length": record.size,
          "cache-control": "private, max-age=3600",
          "x-content-type-options": "nosniff",
        });
        createReadStream(path).pipe(res);
      },
    });
  },
};
