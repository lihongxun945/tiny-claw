/// <reference types="vite/client" />

interface Window {
  breezeCoderDesktop?: {
    selectProjectDirectory(): Promise<string | null>;
  };
}
