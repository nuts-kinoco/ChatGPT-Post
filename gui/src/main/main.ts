import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } from "electron";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { aggregateState, DOCTOR_POLL_INTERVAL_MS, EMPTY_STATE, REQUESTS_POLL_INTERVAL_MS, scanRequests, type BridgeGuiState, type DoctorItem } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BAR_WIDTH = 380;
const BAR_HEIGHT = 40;
const POPUP_HEIGHT = 520;
const WINDOW_MARGIN = 12;
const CLI_PATH = path.resolve(__dirname, "../../../dist/cli/main.js");
const REQUESTS_PATH = path.resolve(__dirname, "../../../runtime/requests");
let tray: Tray | undefined;
let barWindow: BrowserWindow | undefined;
let popupOpen = false;
let doctor = EMPTY_STATE.doctor;
let scannedRequests: Awaited<ReturnType<typeof scanRequests>> = [];
let bridgeState: BridgeGuiState = EMPTY_STATE;

function rendererUrl(): string { return process.env.ELECTRON_RENDERER_URL ?? `file://${path.join(__dirname, "../renderer/index.html")}`; }
function createTrayIcon() { return nativeImage.createFromPath(path.join(__dirname, "../../assets/tray-icon.svg")).resize({ width: 16, height: 16 }); }
function positionWindow() {
  if (!barWindow) return;
  const height = popupOpen ? POPUP_HEIGHT : BAR_HEIGHT;
  const { workArea } = screen.getPrimaryDisplay();
  barWindow.setSize(BAR_WIDTH, height);
  barWindow.setPosition(workArea.x + workArea.width - BAR_WIDTH - WINDOW_MARGIN, workArea.y + workArea.height - height - WINDOW_MARGIN);
}
function showBar() {
  if (!barWindow) {
    barWindow = new BrowserWindow({ width: BAR_WIDTH, height: BAR_HEIGHT, useContentSize: true, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.js") } });
    void barWindow.loadURL(rendererUrl());
    barWindow.on("close", (event) => { event.preventDefault(); barWindow?.hide(); });
  }
  positionWindow();
  barWindow.show();
  barWindow.focus();
}
function publishState() { bridgeState = aggregateState(doctor, scannedRequests); barWindow?.webContents.send("bridge-gui:state", bridgeState); }
function parseDoctor(stdout: string): { ok: boolean; items: DoctorItem[] } {
  const line = stdout.split(/\r?\n/u).find((candidate) => candidate.trim());
  if (!line) throw new Error("doctor --json returned no JSON");
  const parsed: unknown = JSON.parse(line);
  if (!parsed || typeof parsed !== "object") throw new Error("doctor --json returned a non-object");
  const value = parsed as { ok?: unknown; items?: unknown };
  if (typeof value.ok !== "boolean" || !Array.isArray(value.items)) throw new Error("doctor --json has an unexpected shape");
  const items = value.items.filter((item): item is DoctorItem => typeof item === "object" && item !== null && typeof (item as DoctorItem).name === "string" && typeof (item as DoctorItem).ok === "boolean" && typeof (item as DoctorItem).detail === "string");
  if (items.length !== value.items.length) throw new Error("doctor --json contains an invalid item");
  return { ok: value.ok, items };
}
function pollDoctor(): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, "doctor", "--json"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => { console.warn("Bridge GUI: could not start doctor; retrying next tick", error); doctor = { ok: false, items: [], error: error.message }; publishState(); finish(); });
    child.on("close", () => {
      if (settled) return;
      try { doctor = parseDoctor(stdout); }
      catch (error) { console.warn(`Bridge GUI: doctor output could not be parsed; retrying next tick${stderr ? `: ${stderr.trim()}` : ""}`, error); doctor = { ok: false, items: [], error: error instanceof Error ? error.message : "Malformed doctor output" }; }
      publishState();
      finish();
    });
  });
}
async function pollRequests() { scannedRequests = await scanRequests(REQUESTS_PATH); publishState(); }

app.whenReady().then(() => {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("ChatGPT Bridge Control");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "Show", click: showBar }, { type: "separator" }, { label: "Quit", click: () => app.quit() }]));
  tray.on("click", showBar);
  ipcMain.on("bridge-gui:subscribe", (event) => event.sender.send("bridge-gui:state", bridgeState));
  ipcMain.on("bridge-gui:toggle-popup", () => { popupOpen = !popupOpen; positionWindow(); });
  void pollDoctor();
  void pollRequests();
  setInterval(() => { void pollDoctor(); }, DOCTOR_POLL_INTERVAL_MS);
  setInterval(() => { void pollRequests(); }, REQUESTS_POLL_INTERVAL_MS);
});
