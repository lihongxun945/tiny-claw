import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { encodeSessionId, sessionDir } from "./session-store.js";
import type { AttachmentsConfig, ImageBlock, ImageMediaType } from "./types.js";

const DEFAULT_MAX_FILES = 4;
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;
const DEFAULT_TYPES: ImageMediaType[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export interface AttachmentRecord {
  id: string;
  sessionId: string;
  name: string;
  mediaType: ImageMediaType;
  size: number;
  path: string;
}

export function attachmentLimits(config?: AttachmentsConfig): {
  enabled: boolean;
  maxFilesPerMessage: number;
  maxFileSize: number;
  allowedImageTypes: ImageMediaType[];
} {
  return {
    enabled: config?.enabled !== false,
    maxFilesPerMessage: config?.maxFilesPerMessage ?? DEFAULT_MAX_FILES,
    maxFileSize: config?.maxFileSize ?? DEFAULT_MAX_SIZE,
    allowedImageTypes: config?.allowedImageTypes ?? DEFAULT_TYPES,
  };
}

export function saveAttachment(
  workspacePath: string,
  sessionId: string,
  name: string,
  declaredType: string,
  data: Buffer,
  config?: AttachmentsConfig,
): AttachmentRecord {
  const limits = attachmentLimits(config);
  if (!limits.enabled) throw new Error("图片上传已禁用");
  if (data.length === 0) throw new Error("图片内容为空");
  if (data.length > limits.maxFileSize) throw new Error(`图片大小不能超过 ${limits.maxFileSize} 字节`);

  const mediaType = detectImageType(data);
  if (!mediaType || mediaType !== declaredType) throw new Error("图片格式与声明的 MIME 类型不一致");
  if (!limits.allowedImageTypes.includes(mediaType)) throw new Error(`不支持的图片类型：${mediaType}`);

  const id = randomUUID();
  const extension = extensionForType(mediaType);
  const relativePath = `sessions/${encodeSessionId(sessionId)}/attachments/${id}${extension}`;
  const dir = resolve(sessionDir(workspacePath, sessionId), "attachments");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(workspacePath, relativePath), data);

  const record: AttachmentRecord = {
    id,
    sessionId,
    name: sanitizeName(name, extension),
    mediaType,
    size: data.length,
    path: relativePath,
  };
  writeFileSync(resolve(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  return record;
}

export function readAttachment(
  workspacePath: string,
  sessionId: string,
  id: string,
): AttachmentRecord | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const metadataPath = resolve(sessionDir(workspacePath, sessionId), "attachments", `${id}.json`);
  if (!existsSync(metadataPath)) return undefined;
  try {
    const record = JSON.parse(readFileSync(metadataPath, "utf-8")) as AttachmentRecord;
    if (record.id !== id || record.sessionId !== sessionId) return undefined;
    resolveAttachmentPath(workspacePath, record.path);
    return record;
  } catch {
    return undefined;
  }
}

export function attachmentToImageBlock(record: AttachmentRecord): ImageBlock {
  return {
    type: "image",
    id: record.id,
    name: record.name,
    source: {
      type: "attachment",
      path: record.path,
      mediaType: record.mediaType,
    },
  };
}

export function resolveAttachmentPath(workspacePath: string, relativePath: string): string {
  const root = resolve(workspacePath, "sessions");
  const absolute = resolve(workspacePath, relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error("附件路径越界");
  }
  return absolute;
}

export function readImageBlockData(workspacePath: string, block: ImageBlock): Buffer {
  return readFileSync(resolveAttachmentPath(workspacePath, block.source.path));
}

function detectImageType(data: Buffer): ImageMediaType | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (data.length >= 6 && ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) return "image/gif";
  return undefined;
}

function extensionForType(mediaType: ImageMediaType): string {
  if (mediaType === "image/jpeg") return ".jpg";
  return `.${mediaType.slice("image/".length)}`;
}

function sanitizeName(name: string, fallbackExtension: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() || `image${fallbackExtension}`;
  const safe = base.replace(/[^\w.\- ()\u4e00-\u9fff]/g, "_").slice(0, 120);
  return extname(safe) ? safe : `${safe}${fallbackExtension}`;
}
