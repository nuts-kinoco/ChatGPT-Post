/** Read-only state plus six allowlisted cosmetic window actions; no legacy CLI/file APIs. */
import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("bridgeProduct", {
  state: () => ipcRenderer.invoke("bridge-product:state"),
  action: (action: unknown) => {
    if (typeof action !== "string" || !["expand", "collapse", "hide", "restore", "minimize", "settings"].includes(action))
      return Promise.reject(new Error("product_window_action_denied"));
    return ipcRenderer.invoke("bridge-product:action", action);
  },
  onState(callback: (value: unknown) => void) {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
    ipcRenderer.on("bridge-product:state", listener);
    return () => ipcRenderer.removeListener("bridge-product:state", listener);
  },
});
