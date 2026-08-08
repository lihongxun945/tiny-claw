import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config, Tool } from "../types.js";
import { checkDangerousToolPermission } from "./permission.js";

export type ProfileSource = "manual" | "tool" | "auto";

export interface ProfileRecord {
  name: string;
  summary: string;
  content: string;
  disabled: boolean;
  source: ProfileSource;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileLimits {
  maxItemChars: number;
  maxTotalChars: number;
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function profileDir(workspacePath: string): string {
  const dir = resolve(workspacePath, "profile");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function profilePath(workspacePath: string, name: string): string {
  if (!NAME_PATTERN.test(name)) throw new Error("Profile 名称只能包含字母、数字、下划线和连字符");
  return resolve(profileDir(workspacePath), `${name}.md`);
}

function parse(raw: string, fallbackName: string): ProfileRecord {
  const now = new Date().toISOString();
  const record: ProfileRecord = { name: fallbackName, summary: "", content: raw.trim(), disabled: false, source: "tool", createdAt: now, updatedAt: now };
  if (!raw.startsWith("---\n")) return record;
  const end = raw.indexOf("\n---", 4);
  if (end < 0) return record;
  record.content = raw.slice(end + 4).trim();
  for (const line of raw.slice(4, end).split("\n")) {
    const index = line.indexOf(":");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key === "name") record.name = value || fallbackName;
    if (key === "summary") record.summary = value;
    if (key === "disabled") record.disabled = value === "true";
    if (key === "source" && ["manual", "tool", "auto"].includes(value)) record.source = value as ProfileSource;
    if (key === "createdAt") record.createdAt = value || now;
    if (key === "updatedAt") record.updatedAt = value || now;
  }
  return record;
}

function format(record: ProfileRecord): string {
  return [
    "---",
    `name: ${record.name}`,
    `summary: ${record.summary.replace(/\n/g, " ")}`,
    `disabled: ${record.disabled}`,
    `source: ${record.source}`,
    `createdAt: ${record.createdAt}`,
    `updatedAt: ${record.updatedAt}`,
    "---",
    "",
    record.content.trim(),
    "",
  ].join("\n");
}

export function listProfiles(workspacePath: string, includeDisabled = true): ProfileRecord[] {
  const records = readdirSync(profileDir(workspacePath)).filter((file) => file.endsWith(".md")).sort().map((file) => {
    const name = file.slice(0, -3);
    return parse(readFileSync(resolve(profileDir(workspacePath), file), "utf-8"), name);
  });
  return includeDisabled ? records : records.filter((record) => !record.disabled);
}

export function getProfile(workspacePath: string, name: string): ProfileRecord | null {
  const path = profilePath(workspacePath, name);
  return existsSync(path) ? parse(readFileSync(path, "utf-8"), name) : null;
}

function validateCapacity(workspacePath: string, name: string, content: string, disabled: boolean, limits: ProfileLimits): void {
  if (content.trim().length > limits.maxItemChars) throw new Error(`Profile 单条内容超过上限: ${content.trim().length}/${limits.maxItemChars}`);
  if (disabled) return;
  const total = listProfiles(workspacePath, false).filter((item) => item.name !== name).reduce((sum, item) => sum + item.content.length, content.trim().length);
  if (total > limits.maxTotalChars) throw new Error(`Profile 总内容超过上限: ${total}/${limits.maxTotalChars}`);
}

export function saveProfile(workspacePath: string, input: { name: string; content: string; summary?: string; disabled?: boolean; source?: ProfileSource }, limits: ProfileLimits): ProfileRecord {
  const existing = getProfile(workspacePath, input.name);
  const now = new Date().toISOString();
  const record: ProfileRecord = {
    name: input.name,
    content: input.content.trim(),
    summary: input.summary?.trim() || input.content.trim().replace(/\s+/g, " ").slice(0, 80),
    disabled: input.disabled ?? existing?.disabled ?? false,
    source: input.source ?? existing?.source ?? "tool",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  validateCapacity(workspacePath, record.name, record.content, record.disabled, limits);
  writeFileSync(profilePath(workspacePath, record.name), format(record), "utf-8");
  return record;
}

export function deleteProfile(workspacePath: string, name: string): boolean {
  const path = profilePath(workspacePath, name);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function formatProfilesForPrompt(workspacePath: string, maxTotalChars: number): string {
  const profiles = listProfiles(workspacePath, false);
  if (profiles.length === 0) return "";
  const sections = ["以下是用户长期稳定的身份、偏好和约束，每轮都必须遵守。"];
  for (const profile of profiles) {
    const section = `\n## ${profile.name}\n${profile.content}`;
    if (`${sections.join("\n")}\n${section}`.length > maxTotalChars) throw new Error(`启用的 Profile 内容超过注入上限 ${maxTotalChars}`);
    sections.push(section);
  }
  return sections.join("\n");
}

export function getProfileLimits(config: Config): ProfileLimits {
  return { maxItemChars: config.profile?.maxItemChars ?? 2000, maxTotalChars: config.profile?.maxTotalChars ?? 8000 };
}

export function createProfileListTool(workspacePath: string): Tool {
  return { name: "profile_list", description: "列出每轮固定注入的用户 Profile", inputSchema: { type: "object", properties: {} }, execute: async () => JSON.stringify({ profiles: listProfiles(workspacePath).map(({ content: _content, ...item }) => item) }) };
}

export function createProfileReadTool(workspacePath: string): Tool {
  return { name: "profile_read", description: "读取指定用户 Profile 的完整内容", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, execute: async (args) => JSON.stringify({ profile: getProfile(workspacePath, String(args.name ?? "")) }) };
}

export function createProfileSaveTool(workspacePath: string, getConfig: () => Config): Tool {
  return {
    name: "profile_save",
    description: "保存稳定且每轮都应遵守的用户身份、偏好或长期约束；不要保存项目事实和一次性任务",
    inputSchema: { type: "object", properties: { name: { type: "string" }, content: { type: "string" }, summary: { type: "string" } }, required: ["name", "content"] },
    async execute(args, context) {
      const permission = checkDangerousToolPermission({ workspacePath, config: getConfig(), toolName: "profile_save", args, context, command: `profile_save ${String(args.name ?? "")}`, cwd: profileDir(workspacePath) });
      if (!permission.allowed) return permission.result;
      return JSON.stringify({ profile: saveProfile(workspacePath, { name: String(args.name), content: String(args.content), summary: typeof args.summary === "string" ? args.summary : undefined, source: args.source === "auto" ? "auto" : "tool" }, getProfileLimits(getConfig())) });
    },
  };
}

export function createProfileDeleteTool(workspacePath: string, getConfig: () => Config): Tool {
  return {
    name: "profile_delete",
    description: "删除用户明确要求遗忘或确认已失效的 Profile",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async execute(args, context) {
      const permission = checkDangerousToolPermission({ workspacePath, config: getConfig(), toolName: "profile_delete", args, context, command: `profile_delete ${String(args.name ?? "")}`, cwd: profileDir(workspacePath) });
      if (!permission.allowed) return permission.result;
      return JSON.stringify({ deleted: deleteProfile(workspacePath, String(args.name ?? "")) });
    },
  };
}
