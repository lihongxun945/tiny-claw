export interface DesktopWindow {
  focus(): void;
  hide(): void;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
}

export interface CloseEvent {
  preventDefault(): void;
}

export function showDesktopWindow(window: DesktopWindow | null): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export function handleDesktopWindowClose(
  event: CloseEvent,
  window: DesktopWindow,
  quitting: boolean,
): void {
  if (quitting) return;
  event.preventDefault();
  window.hide();
}

export function shouldQuitWhenAllWindowsClosed(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}
