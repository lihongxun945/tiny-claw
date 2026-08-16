import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { ensureWebBuild } from "../../src/web-build.js";

describe("ensureWebBuild", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function createRoot(): string {
    const root = mkdtempSync(resolve(tmpdir(), "tiny-claw-web-build-"));
    roots.push(root);
    return root;
  }

  it("skips the build when web/dist/index.html exists", () => {
    const root = createRoot();
    mkdirSync(resolve(root, "web/dist"), { recursive: true });
    writeFileSync(resolve(root, "web/dist/index.html"), "ready");
    const run = vi.fn();

    expect(ensureWebBuild(root, run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("builds missing assets before returning", () => {
    const root = createRoot();
    const run = vi.fn((_command, _args, options) => {
      mkdirSync(resolve(options!.cwd!.toString(), "web/dist"), { recursive: true });
      writeFileSync(resolve(options!.cwd!.toString(), "web/dist/index.html"), "ready");
      return { status: 0 };
    });

    expect(ensureWebBuild(root, run as never)).toBe(true);
    expect(run).toHaveBeenCalledWith(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "web:build"],
      { cwd: root, stdio: "inherit" },
    );
  });

  it("fails startup when the build command fails", () => {
    const root = createRoot();
    const run = vi.fn(() => ({ status: 1 }));

    expect(() => ensureWebBuild(root, run as never)).toThrow("WebUI 自动构建失败，退出码: 1");
  });
});
