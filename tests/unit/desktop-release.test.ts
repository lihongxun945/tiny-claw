import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("desktop release", () => {
  it("keeps packaging separate from GitHub Release publishing", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8"));
    const workflow = readFileSync(
      resolve(process.cwd(), ".github/workflows/desktop-release.yml"),
      "utf-8",
    );

    expect(packageJson.scripts["desktop:dist"]).toContain("--publish never");
    expect(packageJson.build.mac.icon).toBe("build/icon.png");
    expect(packageJson.build.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "build/trayTemplate.png",
        to: "trayTemplate.png",
      }),
      expect.objectContaining({
        from: "build/trayTemplate@2x.png",
        to: "trayTemplate@2x.png",
      }),
      expect.objectContaining({
        from: "build/icon.png",
        to: "loading-logo.png",
      }),
    ]));
    expect(workflow).toContain("permissions:\n  contents: write");
    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
    expect(workflow).toContain('gh release create "${GITHUB_REF_NAME}"');
  });
});
