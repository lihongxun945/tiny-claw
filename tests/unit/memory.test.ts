import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  appendMemory,
  createMemoryAppendTool,
  createMemoryDeleteTool,
  createMemoryListTool,
  createMemoryReadTool,
  createMemorySaveTool,
  deleteMemory,
  getMemoryRecord,
  listMemories,
  listMemoryRecords,
  loadAllMemories,
  readMemory,
  restoreMemory,
  runMemoryMaintenance,
  saveMemory,
  setMemoryDisabled,
  updateMemoryRecord,
} from "../../src/tools/memory.js";
import { loadConfig } from "../../src/config.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("memory storage", () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = createTempWorkspace();
  });

  afterEach(() => {
    removeTempWorkspace(workspacePath);
  });

  it("saves, reads, updates, appends and deletes a memory", () => {
    expect(saveMemory(workspacePath, "user-pref", "喜欢简洁回答", {
      tags: ["preference"],
      scope: "user",
      summary: "回答偏好",
      source: "manual",
    })).toBe("已保存记忆: user-pref");

    expect(getMemoryRecord(workspacePath, "user-pref")).toMatchObject({
      name: "user-pref",
      summary: "回答偏好",
      tags: ["preference"],
      scope: "user",
      source: "manual",
      disabled: false,
    });

    updateMemoryRecord(workspacePath, "user-pref", {
      content: "喜欢简洁回答，并优先使用中文",
      tags: ["preference", "language"],
    });
    appendMemory(workspacePath, "user-pref", "避免冗长背景说明");

    expect(JSON.parse(readMemory(workspacePath, "user-pref"))).toMatchObject({
      content: "喜欢简洁回答，并优先使用中文\n避免冗长背景说明",
      meta: {
        tags: ["preference", "language"],
      },
    });

    expect(deleteMemory(workspacePath, "user-pref")).toBe("已将记忆移入回收站: user-pref");
    expect(getMemoryRecord(workspacePath, "user-pref")).toBeNull();
    expect(restoreMemory(workspacePath, "user-pref")).toBe("已恢复记忆: user-pref");
    expect(getMemoryRecord(workspacePath, "user-pref")?.status).toBe("active");
  });

  it("requires both turn and time thresholds before marking memory stale", () => {
    saveMemory(workspacePath, "durable", "长期有效", { summary: "长期记忆" });
    expect(runMemoryMaintenance(workspacePath, {
      inactiveTurns: 1,
      inactiveDays: 30,
      trashRetentionDays: 30,
    }).stale).toBe(0);
    expect(getMemoryRecord(workspacePath, "durable")?.status).toBe("active");
  });

  it("injects all enabled memories and keeps disabled memories out of prompts", () => {
    saveMemory(workspacePath, "public", "公开项目背景", { tags: ["project"] });
    writeFileSync(resolve(workspacePath, "memory", "legacy-sensitive.md"), [
      "---",
      "name: legacy-sensitive",
      "sensitive: true",
      "disabled: false",
      "---",
      "",
      "旧敏感字段会被忽略并全文注入",
    ].join("\n"), "utf-8");
    saveMemory(workspacePath, "disabled", "旧项目背景", { disabled: true });

    expect(loadAllMemories(workspacePath)).toContain("public");
    expect(loadAllMemories(workspacePath)).toContain("公开项目背景");
    expect(loadAllMemories(workspacePath)).toContain("legacy-sensitive");
    expect(loadAllMemories(workspacePath)).toContain("旧敏感字段会被忽略并全文注入");
    expect(loadAllMemories(workspacePath)).not.toContain("disabled");
    expect(listMemoryRecords(workspacePath).map((memory) => memory.name)).toEqual(["legacy-sensitive", "public"]);

    expect(listMemoryRecords(workspacePath, {
      includeDisabled: true,
    }).map((memory) => memory.name)).toEqual(["disabled", "legacy-sensitive", "public"]);
  });

  it("injects full enabled memory content into prompts", () => {
    saveMemory(workspacePath, "long-rule", "第一条规则：输出必须完整。\n第二条规则：不要只发送摘要。", {
      tags: ["rule"],
      summary: "规则摘要",
    });

    const injected = loadAllMemories(workspacePath);
    expect(injected).toContain("以下是已启用的长期记忆全文。");
    expect(injected).toContain("## long-rule");
    expect(injected).toContain("tags=rule");
    expect(injected).toContain("第一条规则：输出必须完整。");
    expect(injected).toContain("第二条规则：不要只发送摘要。");
    expect(injected).not.toContain("规则摘要");
  });

  it("supports disabling and enabling an existing memory", () => {
    saveMemory(workspacePath, "project", "tiny-claw");
    expect(setMemoryDisabled(workspacePath, "project", true).disabled).toBe(true);
    expect(listMemories(workspacePath)).toBe("暂无记忆");
    expect(setMemoryDisabled(workspacePath, "project", false).disabled).toBe(false);
    expect(JSON.parse(listMemories(workspacePath)).memories).toHaveLength(1);
  });

  it("reads legacy markdown files without frontmatter", () => {
    writeFileSync(resolve(workspacePath, "memory", "legacy.md"), "legacy content\n", "utf-8");

    expect(getMemoryRecord(workspacePath, "legacy")).toMatchObject({
      name: "legacy",
      content: "legacy content",
      summary: "legacy content",
      scope: "global",
      source: "tool",
      disabled: false,
    });
  });

  it("persists the new metadata fields in frontmatter", () => {
    saveMemory(workspacePath, "auto-note", "自动整理内容", {
      disabled: true,
      source: "auto",
    });

    const raw = readFileSync(resolve(workspacePath, "memory", "auto-note.md"), "utf-8");
    expect(raw).toContain("disabled: true");
    expect(raw).toContain("source: auto");
  });

  it("rejects unsafe names", () => {
    expect(() => saveMemory(workspacePath, "../secret", "bad")).toThrow("记忆名称只能包含");
    expect(() => readMemory(workspacePath, "folder/name")).toThrow("记忆名称只能包含");
  });

  it("rejects item and total capacity overflow without writing truncated content", async () => {
    const limitedWorkspace = createTempWorkspace({
      memory: { maxItemChars: 1000, maxTotalChars: 1500 },
    });
    const getConfig = () => loadConfig(limitedWorkspace);
    try {
      const saveTool = createMemorySaveTool(limitedWorkspace, getConfig);
      const oversized = await saveTool.execute({
        name: "oversized",
        content: "A".repeat(1001),
      });
      expect(JSON.parse(oversized)).toMatchObject({
        error: "memory_content_too_large",
        actualChars: 1001,
        maxChars: 1000,
        retryable: true,
      });
      expect(getMemoryRecord(limitedWorkspace, "oversized")).toBeNull();

      expect(await saveTool.execute({ name: "first", content: "A".repeat(900) })).toBe("已保存记忆: first");
      const totalOverflow = await saveTool.execute({ name: "second", content: "B".repeat(700) });
      expect(JSON.parse(totalOverflow)).toMatchObject({
        error: "memory_total_too_large",
        actualChars: 1600,
        maxChars: 1500,
      });
      expect(getMemoryRecord(limitedWorkspace, "second")).toBeNull();
    } finally {
      removeTempWorkspace(limitedWorkspace);
    }
  });

  it("exposes memory storage through tool wrappers", async () => {
    const getConfig = () => ({
      ...loadConfig(workspacePath),
      security: { mode: "allow" as const },
    });
    expect(await createMemorySaveTool(workspacePath, getConfig).execute({
      name: "tool-memory",
      content: "tool content",
      tags: ["tool"],
      scope: "project",
      summary: "tool summary",
    })).toBe("已保存记忆: tool-memory");
    expect(await createMemoryAppendTool(workspacePath, getConfig).execute({
      name: "tool-memory",
      content: "more content",
    })).toBe("已追加记忆: tool-memory");
    expect(JSON.parse(await createMemoryListTool(workspacePath).execute({})).memories).toHaveLength(1);
    expect(JSON.parse(await createMemoryReadTool(workspacePath).execute({ name: "tool-memory" })).content).toContain("more content");
    expect(await createMemoryDeleteTool(workspacePath, getConfig).execute({ name: "tool-memory" })).toBe("已将记忆移入回收站: tool-memory");
  });
});
