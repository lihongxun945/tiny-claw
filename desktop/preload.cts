import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("tinyClawDesktop", {
  selectProjectDirectory: (): Promise<string | null> => ipcRenderer.invoke("project:select-directory"),
});
