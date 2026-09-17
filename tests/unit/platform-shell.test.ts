import { describe, expect, it } from "vitest";
import { nativeShellPath, resolveBash } from "../../src/platform/shell.js";

describe("platform shell", () => {
  it("keeps POSIX shell selection unchanged", () => {
    expect(resolveBash("darwin", {}, () => false)).toBe("bash");
  });
  it("finds Git for Windows in paths containing spaces", () => {
    const paths = new Set(["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\cmd\\git.exe"]);
    expect(resolveBash("win32", { ProgramFiles: "C:\\Program Files" }, p => paths.has(p))).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });
  it("discovers a custom Git install from case-insensitive PATH", () => {
    const paths = new Set(["D:\\Tools\\Git\\bin\\bash.exe", "D:\\Tools\\Git\\cmd\\git.exe"]);
    expect(resolveBash("win32", { Path: "D:\\Tools\\Git\\cmd" }, p => paths.has(p))).toBe("D:\\Tools\\Git\\bin\\bash.exe");
  });
  it("does not use WSL bash or arbitrary relative PATH entries", () => {
    expect(() => resolveBash("win32", { PATH: "C:\\Windows\\System32;." }, p => p.endsWith("bash.exe"))).toThrow("Git for Windows");
  });
  it.each([
    ["C:/项目/hello world", "C:/项目/hello world"], ["/d/project", "d:/project"],
    ["relative/file", "relative/file"], ["/tmp/out", undefined], ["/usr/bin", undefined],
    ["C:relative", undefined], ["C:\\project", undefined], ["//server/share", undefined],
  ])("maps shell path %s without guessing mount points", (path, expected) => {
    expect(nativeShellPath(path!, "win32")).toBe(expected);
  });
});
