import { describe, expect, it } from "vitest";
import { resolveInitialTheme } from "../../web/src/lib/theme.js";

describe("WebUI theme preference", () => {
  it("prefers a persisted valid theme over the system preference", () => {
    expect(resolveInitialTheme("light", true)).toBe("light");
    expect(resolveInitialTheme("dark", false)).toBe("dark");
  });

  it("falls back to the system preference for missing or invalid values", () => {
    expect(resolveInitialTheme(null, true)).toBe("dark");
    expect(resolveInitialTheme("invalid", false)).toBe("light");
  });
});
