import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("breezeCoderDesktop", {
  selectProjectDirectory: (): Promise<string | null> => ipcRenderer.invoke("project:select-directory"),
});
