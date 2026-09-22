import { describe, it, expect } from "vitest";
import { matchRoutePath } from "../../src/plugins/route-matcher.js";

describe("matchRoutePath", () => {
  it("matches a static path and returns empty params", () => {
    expect(matchRoutePath("/models", "/models")).toEqual({});
  });

  it("returns null when a static path does not match", () => {
    expect(matchRoutePath("/models", "/other")).toBeNull();
  });

  it("extracts a single dynamic segment", () => {
    expect(matchRoutePath("/sessions/:id/model", "/sessions/abc123/model")).toEqual({ id: "abc123" });
  });

  it("extracts multiple dynamic segments", () => {
    expect(matchRoutePath("/projects/:projectId/sessions/:id", "/projects/p1/sessions/s2"))
      .toEqual({ projectId: "p1", id: "s2" });
  });

  it("returns null on segment count mismatch", () => {
    expect(matchRoutePath("/sessions/:id/model", "/sessions/abc")).toBeNull();
    expect(matchRoutePath("/sessions/:id", "/sessions/abc/model")).toBeNull();
  });

  it("returns null when a dynamic segment is empty", () => {
    expect(matchRoutePath("/sessions/:id/model", "/sessions//model")).toBeNull();
  });

  it("returns null when a literal segment differs", () => {
    expect(matchRoutePath("/sessions/:id/model", "/sessions/abc/other")).toBeNull();
  });

  it("does not decode the captured segment", () => {
    expect(matchRoutePath("/sessions/:id", "/sessions/a%2Fb")).toEqual({ id: "a%2Fb" });
  });
});
