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
    expect(workflow).toContain("permissions:\n  contents: write");
    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
    expect(workflow).toContain('gh release create "${GITHUB_REF_NAME}"');
  });
});
