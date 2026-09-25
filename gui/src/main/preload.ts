import { contextBridge, ipcRenderer } from "electron";
import type { BridgeGuiState } from "./state.js";
import type { RequestDetail } from "./main.js";
import type { StopRequestResult } from "./main.js";
import type { RefreshCookieResult } from "./main.js";
import type { SubmitNewResult } from "./main.js";
import type { NewSubmissionInput } from "./submit-new.js";
import type { WindowControlState } from "./main.js";

contextBridge.exposeInMainWorld("bridgeGui", {
  onState(callback: (state: BridgeGuiState) => void) {
    const listener = (_event: Electron.IpcRendererEvent, state: BridgeGuiState) => callback(state);
    ipcRenderer.on("bridge-gui:state", listener);
    ipcRenderer.send("bridge-gui:subscribe");
    return () => ipcRenderer.removeListener("bridge-gui:state", listener);
  },
  togglePopup() { ipcRenderer.send("bridge-gui:toggle-popup"); },
  windowControls(): Promise<WindowControlState> { return ipcRenderer.invoke("bridge-gui:window-controls"); },
  toggleAlwaysOnTop(): Promise<WindowControlState> { return ipcRenderer.invoke("bridge-gui:toggle-always-on-top"); },
  toggleMute(): Promise<WindowControlState> { return ipcRenderer.invoke("bridge-gui:toggle-mute"); },
  getAutostart(): Promise<boolean> { return ipcRenderer.invoke("bridge-gui:get-autostart"); },
  setAutostart(openAtLogin: boolean): Promise<boolean> { return ipcRenderer.invoke("bridge-gui:set-autostart", openAtLogin); },
  requestDetail(requestId: string): Promise<RequestDetail | { error: string }> { return ipcRenderer.invoke("bridge-gui:request-detail", requestId); },
  openConversation(requestId: string): Promise<boolean> { return ipcRenderer.invoke("bridge-gui:open-conversation", requestId); },
  stopRequest(requestId: string): Promise<StopRequestResult> { return ipcRenderer.invoke("bridge-gui:stop", requestId); },
  refreshCookie(): Promise<RefreshCookieResult> { return ipcRenderer.invoke("bridge-gui:refresh-cookie"); },
  chooseNewAttachments(): Promise<string[]> { return ipcRenderer.invoke("bridge-gui:choose-new-attachments"); },
  submitNew(input: NewSubmissionInput): Promise<SubmitNewResult> { return ipcRenderer.invoke("bridge-gui:submit-new", input); },
});
