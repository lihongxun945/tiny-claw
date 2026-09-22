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
    expect(packageJson.scripts["desktop:dist:win"]).toContain("--win nsis --x64 --publish never");
    expect(packageJson.build.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(packageJson.build.win.forceCodeSigning).toBe(false);
    expect(packageJson.dependencies["apache-arrow"]).toBe("18.1.0");
    expect(packageJson.build.nsis.deleteAppDataOnUninstall).toBe(false);
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
    expect(workflow.replace(/\r\n/g, "\n")).toContain("permissions:\n  contents: write");
    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
    expect(workflow).toContain('gh release create "${GITHUB_REF_NAME}"');
    expect(workflow).toContain("needs: [macos, windows]");
    expect(workflow).toContain("runs-on: windows-2022");
    expect(workflow.match(/run: npm run test:all/g)).toHaveLength(2);
    expect(workflow).toContain("run: npm run desktop:smoke");
    expect(workflow).toContain('npm run desktop:smoke -- "$installPath"');
    expect(workflow).toContain('/S /currentuser /D=`"$installPath`"');
    expect(workflow).toContain("$_.DisplayVersion -eq $version");
    expect(workflow).toContain('HKCU:\\Software\\$($entries[0].PSChildName)');
    expect(workflow).toContain("Registered installation directory:");
    expect(workflow).toContain("Installation directory mismatch:");
    expect(workflow).toContain("/S /currentuser _?=$actualPath");
    expect(workflow).toContain("Uninstaller did not remove the application");
  });
});
