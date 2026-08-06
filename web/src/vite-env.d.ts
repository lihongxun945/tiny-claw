/// <reference types="vite/client" />

interface Window {
  tinyClawDesktop?: {
    selectProjectDirectory(): Promise<string | null>;
  };
}
