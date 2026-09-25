import { app, BrowserWindow, Menu, Tray, nativeImage, screen } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BAR_WIDTH = 380;
const BAR_HEIGHT = 40;
let tray: Tray | undefined;
let barWindow: BrowserWindow | undefined;

function rendererUrl(): string {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  return devUrl ?? `file://${path.join(__dirname, "../renderer/index.html")}`;
}

function createTrayIcon() {
  const iconPath = path.join(__dirname, "../../assets/tray-icon.svg");
  return nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
}

function showBar() {
  if (!barWindow) {
    barWindow = new BrowserWindow({
      width: BAR_WIDTH,
      height: BAR_HEIGHT,
      useContentSize: true,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    void barWindow.loadURL(rendererUrl());
    barWindow.on("close", (event) => {
      event.preventDefault();
      barWindow?.hide();
    });
  }

  const { workArea } = screen.getPrimaryDisplay();
  barWindow.setPosition(workArea.x + workArea.width - BAR_WIDTH - 12, workArea.y + workArea.height - BAR_HEIGHT - 12);
  barWindow.show();
  barWindow.focus();
}

app.whenReady().then(() => {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("ChatGPT Bridge Control");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show", click: showBar },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
  tray.on("click", showBar);
});
