import { randomUUID } from "node:crypto";
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain } from "electron";
import {
  createNotificationCredentialController, NOTIFICATION_CREDENTIAL_CHANNELS, NOTIFICATION_CREDENTIAL_SCHEME,
  NOTIFICATION_CREDENTIAL_SESSION_MS, NOTIFICATION_CREDENTIAL_URL,
  validateNotificationCredentialView, type NotificationCredentialRequest,
} from "./notification-credential-controller.js";
import { isNotificationCredentialResource, notificationCredentialResource } from "./notification-credential-page.js";

export interface NotificationCredentialDialog { open(request: NotificationCredentialRequest): {close(): void}; }
/** This adapter has no runtime Electron import, so tests inject every native boundary. */
export function createNotificationCredentialDialog(options: {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  preloadPath: string;
  wallNow?: () => number;
  monotonicNow?: () => number;
}): NotificationCredentialDialog {
  let active: ReturnType<typeof createNotificationCredentialController> | undefined;
  return {
    open(request) {
      let constructing: BrowserWindow | undefined;
      try {
        if (active || !validateNotificationCredentialView(request.view)) throw new Error("notification_credential_window_unavailable");
        const window = options.createWindow({
          width: 740, height: 820, minWidth: 620, minHeight: 560, show: false,
          title: "通知用の認証情報", autoHideMenuBar: true,
          webPreferences: {
            partition: `bridge-notification-credential-${randomUUID()}`,
            preload: options.preloadPath, contextIsolation: true, sandbox: true, webSecurity: true,
            nodeIntegration: false, nodeIntegrationInWorker: false, devTools: false, spellcheck: false,
            webviewTag: false, navigateOnDragDrop: false,
          },
        });
        constructing = window;
        const contents = window.webContents;
        const session = contents.session;
        const installedChannels: string[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let protocolInstalled = false;
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          if (active === controller) active = undefined;
          if (timer) clearTimeout(timer);
          for (const channel of installedChannels) {
            try { options.ipcMain.removeHandler(channel); } catch { /* Inert controller still rejects all calls. */ }
          }
          if (protocolInstalled) {
            try { session.protocol.unhandle(NOTIFICATION_CREDENTIAL_SCHEME); } catch { /* Disposed handler rejects every resource. */ }
          }
          // Keep permission/request denial on the now-unused ephemeral session until it is collected.
          try { if (!window.isDestroyed()) window.destroy(); } catch { /* Revoked callbacks remain inert. */ }
        };
        const controller = createNotificationCredentialController({request, sender: contents, session,
          mainFrame: contents.mainFrame, wallNow: options.wallNow, monotonicNow: options.monotonicNow, dispose});
        active = controller;
        try {
          session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
          session.setPermissionCheckHandler(() => false);
          session.on("will-download", event => { event.preventDefault(); controller.cancel(); });
          session.webRequest.onBeforeRequest((details, callback) => {
            callback({cancel: disposed || details.webContentsId !== contents.id || details.method !== "GET"
              || !isNotificationCredentialResource(details.url, details.resourceType)});
          });
          contents.setWindowOpenHandler(() => ({action: "deny"}));
          contents.on("will-navigate", event => { event.preventDefault(); controller.cancel(); });
          contents.on("will-frame-navigate", event => { event.preventDefault(); controller.cancel(); });
          contents.on("will-redirect", event => { event.preventDefault(); controller.cancel(); });
          contents.on("will-attach-webview", event => { event.preventDefault(); controller.cancel(); });
          contents.on("did-navigate", (_event, url) => controller.didNavigate(url, contents.mainFrame));
          contents.on("did-frame-navigate", (_event, _url, _status, _statusText, isMainFrame) => { if (!isMainFrame) controller.cancel(); });
          contents.on("did-navigate-in-page", () => controller.cancel());
          contents.on("render-process-gone", () => controller.cancel());
          contents.on("destroyed", () => controller.cancel());
          contents.on("did-fail-load", () => controller.cancel());
          window.on("close", () => controller.cancel());
          window.on("closed", () => controller.cancel());
          session.protocol.handle(NOTIFICATION_CREDENTIAL_SCHEME, incoming => {
            try {
              if (!controller.active() || window.isDestroyed()) return new Response("Not found", {status: 404});
              return notificationCredentialResource(incoming, contents.session, session);
            } catch { controller.cancel(); return new Response("Not found", {status: 404}); }
          });
          protocolInstalled = true;
          const handlers = {
            [NOTIFICATION_CREDENTIAL_CHANNELS.view]: controller.view,
            [NOTIFICATION_CREDENTIAL_CHANNELS.submit]: controller.submit,
            [NOTIFICATION_CREDENTIAL_CHANNELS.cancel]: controller.cancelFrom,
          };
          for (const [channel, handler] of Object.entries(handlers)) {
            options.ipcMain.handle(channel, (event, ...args) => handler(event, args));
            installedChannels.push(channel);
          }
          timer = setTimeout(() => controller.cancel(), NOTIFICATION_CREDENTIAL_SESSION_MS);
          timer.unref?.();
          void window.loadURL(NOTIFICATION_CREDENTIAL_URL).then(() => {
            try { if (controller.active() && !window.isDestroyed()) window.show(); }
            catch { controller.cancel(); }
          }, () => controller.cancel());
          return {close: controller.close};
        } catch {
          try { controller.cancel(); } catch { dispose(); }
          throw new Error("notification_credential_window_unavailable");
        }
      } catch {
        try { if (constructing && !constructing.isDestroyed()) constructing.destroy(); } catch { /* No native error is exposed. */ }
        throw new Error("notification_credential_window_unavailable");
      }
    },
  };
}
