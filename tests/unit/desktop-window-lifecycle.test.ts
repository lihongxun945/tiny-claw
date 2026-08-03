import { describe, expect, it, vi } from "vitest";
import {
  handleDesktopWindowClose,
  shouldQuitWhenAllWindowsClosed,
  showDesktopWindow,
  type DesktopWindow,
} from "../../desktop/window-lifecycle.js";

function createWindow(minimized = false): DesktopWindow {
  return {
    focus: vi.fn(),
    hide: vi.fn(),
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(),
    show: vi.fn(),
  };
}

describe("desktop window lifecycle", () => {
  it("hides the window instead of closing while the app remains active", () => {
    const window = createWindow();
    const event = { preventDefault: vi.fn() };

    handleDesktopWindowClose(event, window, false);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
  });

  it("allows the window to close during application quit", () => {
    const window = createWindow();
    const event = { preventDefault: vi.fn() };

    handleDesktopWindowClose(event, window, true);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(window.hide).not.toHaveBeenCalled();
  });

  it("restores and focuses the window from the tray", () => {
    const window = createWindow(true);

    showDesktopWindow(window);

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("keeps the app resident after all macOS windows close", () => {
    expect(shouldQuitWhenAllWindowsClosed("darwin")).toBe(false);
    expect(shouldQuitWhenAllWindowsClosed("win32")).toBe(true);
  });
});
