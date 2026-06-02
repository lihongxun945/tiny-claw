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
  createMemorySearchTool,
  deleteMemory,
  getMemoryRecord,
  listMemories,
  listMemoryRecords,
  loadAllMemories,
  readMemory,
  saveMemory,
  searchMemories,
  setMemoryDisabled,
  updateMemoryRecord,
} from "../../src/tools/memory.js";
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
      sensitive: false,
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

    expect(deleteMemory(workspacePath, "user-pref")).toBe("已删除记忆: user-pref");
    expect(getMemoryRecord(workspacePath, "user-pref")).toBeNull();
  });

  it("keeps sensitive and disabled memories out of default prompt and search", () => {
    saveMemory(workspacePath, "public", "公开项目背景", { tags: ["project"] });
    saveMemory(workspacePath, "sensitive", "private token", { sensitive: true });
    saveMemory(workspacePath, "disabled", "旧项目背景", { disabled: true });

    expect(loadAllMemories(workspacePath)).toContain("public");
    expect(loadAllMemories(workspacePath)).not.toContain("sensitive");
    expect(loadAllMemories(workspacePath)).not.toContain("disabled");
    expect(listMemoryRecords(workspacePath).map((memory) => memory.name)).toEqual(["public"]);
    expect(JSON.parse(searchMemories(workspacePath, "背景")).results.map((memory: { name: string }) => memory.name)).toEqual(["public"]);

    expect(listMemoryRecords(workspacePath, {
      includeSensitive: true,
      includeDisabled: true,
    }).map((memory) => memory.name)).toEqual(["disabled", "public", "sensitive"]);
  });

  it("requires explicit permission to read sensitive memories", () => {
    saveMemory(workspacePath, "secret", "private token", { sensitive: true });

    expect(JSON.parse(readMemory(workspacePath, "secret"))).toEqual({
      error: "记忆 secret 标记为敏感，请显式设置 include_sensitive=true 后读取",
    });
    expect(JSON.parse(readMemory(workspacePath, "secret", true)).content).toBe("private token");
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
      sensitive: false,
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

  it("exposes memory storage through tool wrappers", async () => {
    expect(await createMemorySaveTool(workspacePath).execute({
      name: "tool-memory",
      content: "tool content",
      tags: ["tool"],
      scope: "project",
      summary: "tool summary",
    })).toBe("已保存记忆: tool-memory");
    expect(await createMemoryAppendTool(workspacePath).execute({
      name: "tool-memory",
      content: "more content",
    })).toBe("已追加记忆: tool-memory");
    expect(JSON.parse(await createMemoryListTool(workspacePath).execute({})).memories).toHaveLength(1);
    expect(JSON.parse(await createMemoryReadTool(workspacePath).execute({ name: "tool-memory" })).content).toContain("more content");
    expect(JSON.parse(await createMemorySearchTool(workspacePath).execute({ query: "tool", limit: 1 })).results).toHaveLength(1);
    expect(await createMemoryDeleteTool(workspacePath).execute({ name: "tool-memory" })).toBe("已删除记忆: tool-memory");
  });
});
