import { contextBridge, ipcRenderer } from "electron";
import type { BridgeGuiState } from "./state.js";
import type { RequestDetail } from "./main.js";
import type { StopRequestResult } from "./main.js";

contextBridge.exposeInMainWorld("bridgeGui", {
  onState(callback: (state: BridgeGuiState) => void) {
    const listener = (_event: Electron.IpcRendererEvent, state: BridgeGuiState) => callback(state);
    ipcRenderer.on("bridge-gui:state", listener);
    ipcRenderer.send("bridge-gui:subscribe");
    return () => ipcRenderer.removeListener("bridge-gui:state", listener);
  },
  togglePopup() { ipcRenderer.send("bridge-gui:toggle-popup"); },
  requestDetail(requestId: string): Promise<RequestDetail | { error: string }> { return ipcRenderer.invoke("bridge-gui:request-detail", requestId); },
  openConversation(requestId: string): Promise<boolean> { return ipcRenderer.invoke("bridge-gui:open-conversation", requestId); },
  stopRequest(requestId: string): Promise<StopRequestResult> { return ipcRenderer.invoke("bridge-gui:stop", requestId); },
});
