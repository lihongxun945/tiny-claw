export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "breeze-coder-theme";

export function resolveInitialTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

export function readInitialTheme(): Theme {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
  return resolveInitialTheme(stored, window.matchMedia("(prefers-color-scheme: dark)").matches);
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Applying the in-memory preference is still useful when storage is unavailable.
  }
}
