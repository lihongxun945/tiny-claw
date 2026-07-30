import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { attachmentToImageBlock, readAttachment, resolveAttachmentPath, saveAttachment } from "../../src/attachments.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

describe("attachments", () => {
  let workspacePath = "";

  afterEach(() => {
    if (workspacePath) removeTempWorkspace(workspacePath);
  });

  it("stores image metadata inside its session and restores an image block", () => {
    workspacePath = createTempWorkspace();
    const record = saveAttachment(workspacePath, "session-1", "screen.png", "image/png", PNG);

    expect(readAttachment(workspacePath, "session-1", record.id)).toEqual(record);
    expect(readAttachment(workspacePath, "other-session", record.id)).toBeUndefined();
    expect(existsSync(resolveAttachmentPath(workspacePath, record.path))).toBe(true);
    expect(attachmentToImageBlock(record)).toMatchObject({
      type: "image",
      id: record.id,
      name: "screen.png",
      source: { type: "attachment", mediaType: "image/png" },
    });
  });

  it("rejects mismatched formats, oversized files, and paths outside sessions", () => {
    workspacePath = createTempWorkspace();
    expect(() => saveAttachment(workspacePath, "session-1", "screen.jpg", "image/jpeg", PNG))
      .toThrow("MIME 类型不一致");
    expect(() => saveAttachment(
      workspacePath,
      "session-1",
      "screen.png",
      "image/png",
      PNG,
      { maxFileSize: 4 },
    )).toThrow("图片大小不能超过 4 字节");
    expect(() => resolveAttachmentPath(workspacePath, "../config.json")).toThrow("附件路径越界");
  });
});
