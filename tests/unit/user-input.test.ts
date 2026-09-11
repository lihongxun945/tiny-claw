import { describe, expect, it } from "vitest";
import { validateQuestion, validateAnswer } from "../../src/plugins/core/user-input.js";

const limits = { maxOptions: 3, maxQuestionChars: 100 };
describe("user input validation", () => {
  it("supports text, single choice, multiple choice and custom answers", () => {
    const question = validateQuestion({ question: "Which?", type: "single_choice", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, limits);
    expect(validateAnswer(question, { text: "custom" }, 100)).toEqual({ selectedIds: [], text: "custom" });
    expect(() => validateAnswer(question, { selectedIds: ["a", "b"] }, 100)).toThrow();
    expect(validateAnswer({ ...question, type: "multiple_choice" }, { selectedIds: ["a", "b"] }, 100).selectedIds).toHaveLength(2);
    expect(() => validateAnswer(question, { selectedIds: ["unknown"] }, 100)).toThrow();
    expect(() => validateAnswer(question, { text: "x".repeat(101) }, 100)).toThrow();
    expect(() => validateAnswer(question, {}, 100)).toThrow();
    expect(validateQuestion({ question: "Why?" }, limits).type).toBe("text");
  });
  it("rejects malformed questions before suspending", () => {
    expect(() => validateQuestion({ question: "" }, limits)).toThrow();
    expect(() => validateQuestion({ question: "x".repeat(101) }, limits)).toThrow();
    expect(() => validateQuestion({ question: "?", type: "single_choice", options: [] }, limits)).toThrow();
    expect(() => validateQuestion({ question: "?", type: "single_choice", options: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }, limits)).toThrow();
  });
});
