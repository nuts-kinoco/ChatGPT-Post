/** Dedicated sandbox preload. No generic IPC, file, URL, clipboard or cipher capability. */
import { contextBridge, ipcRenderer } from "electron";
let submitted = false;
contextBridge.exposeInMainWorld("bridgeNotificationCredential", Object.freeze({
  view: () => ipcRenderer.invoke("bridge-notification-credential:view"),
  submit(value: unknown) {
    if (submitted) return Promise.resolve(false);
    submitted = true;
    return ipcRenderer.invoke("bridge-notification-credential:submit", value);
  },
  cancel: () => ipcRenderer.invoke("bridge-notification-credential:cancel"),
}));
