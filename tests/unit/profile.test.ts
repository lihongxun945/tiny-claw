import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";
import { deleteProfile, formatProfilesForPrompt, getProfile, listProfiles, saveProfile } from "../../src/tools/profile.js";
import { LanceVectorMemoryStore } from "../../src/memory/vector-store.js";

describe("profile storage", () => {
  let workspacePath: string;
  const limits = { maxItemChars: 2000, maxTotalChars: 8000 };

  beforeEach(() => { workspacePath = createTempWorkspace(); });
  afterEach(() => { removeTempWorkspace(workspacePath); });

  it("stores enabled profile markdown and injects full content every turn", () => {
    saveProfile(workspacePath, { name: "communication", content: "每次回复以陛下开头。", summary: "称呼偏好", source: "manual" }, limits);
    expect(existsSync(resolve(workspacePath, "profile", "communication.md"))).toBe(true);
    expect(getProfile(workspacePath, "communication")?.summary).toBe("称呼偏好");
    expect(formatProfilesForPrompt(workspacePath, 8000)).toContain("每次回复以陛下开头。");
  });

  it("keeps disabled profiles out of prompts", () => {
    saveProfile(workspacePath, { name: "disabled", content: "不应注入", disabled: true }, limits);
    expect(listProfiles(workspacePath)).toHaveLength(1);
    expect(formatProfilesForPrompt(workspacePath, 8000)).toBe("");
  });

  it("enforces item and total capacity without truncation", () => {
    expect(() => saveProfile(workspacePath, { name: "large", content: "x".repeat(101) }, { maxItemChars: 100, maxTotalChars: 200 })).toThrow("单条内容超过上限");
    saveProfile(workspacePath, { name: "one", content: "x".repeat(90) }, { maxItemChars: 100, maxTotalChars: 150 });
    expect(() => saveProfile(workspacePath, { name: "two", content: "y".repeat(70) }, { maxItemChars: 100, maxTotalChars: 150 })).toThrow("总内容超过上限");
  });

  it("does not write profiles into LanceDB", async () => {
    saveProfile(workspacePath, { name: "identity", content: "用户身份" }, limits);
    expect(await new LanceVectorMemoryStore(workspacePath).list()).toEqual([]);
    expect(deleteProfile(workspacePath, "identity")).toBe(true);
  });
});
