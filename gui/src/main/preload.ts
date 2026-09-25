import { contextBridge, ipcRenderer } from "electron";
import type { BridgeGuiState } from "./state.js";

contextBridge.exposeInMainWorld("bridgeGui", {
  onState(callback: (state: BridgeGuiState) => void) {
    const listener = (_event: Electron.IpcRendererEvent, state: BridgeGuiState) => callback(state);
    ipcRenderer.on("bridge-gui:state", listener);
    ipcRenderer.send("bridge-gui:subscribe");
    return () => ipcRenderer.removeListener("bridge-gui:state", listener);
  },
  togglePopup() { ipcRenderer.send("bridge-gui:toggle-popup"); },
});
