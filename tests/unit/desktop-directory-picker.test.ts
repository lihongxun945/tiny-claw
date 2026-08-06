import { describe, expect, it, vi } from "vitest";
import { selectProjectDirectory } from "../../desktop/directory-picker.js";

describe("desktop directory picker", () => {
  it("returns the selected directory", async () => {
    const showDialog = vi.fn(async () => ({
      canceled: false,
      filePaths: ["/Users/test/project"],
    }));

    await expect(selectProjectDirectory(showDialog)).resolves.toBe("/Users/test/project");
  });

  it("returns null when selection is canceled", async () => {
    const showDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));

    await expect(selectProjectDirectory(showDialog)).resolves.toBeNull();
  });
});
