import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Tray, nativeImage, screen, shell, type MessageBoxOptions } from "electron";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { aggregateState, DOCTOR_POLL_INTERVAL_MS, EMPTY_STATE, REQUESTS_POLL_INTERVAL_MS, scanRequests, type BridgeGuiState, type DoctorItem } from "./state.js";
import { evaluateRefreshCookiePreflight, type RefreshCookiePreflightResult } from "./refresh-cookie.js";
import { addPickerAttachmentPaths, attachmentsArePickerApproved, buildSubmitArgs, createRequestId, validateNewSubmission, writeNewRequest, type NewSubmissionInput } from "./submit-new.js";
import { resolveBridgePaths } from "./bridge-paths.js";
import { portableExecutablePath } from "./login-item.js";
import * as fs from "node:fs/promises";

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BAR_WIDTH = 380;
const BAR_HEIGHT = 40;
const POPUP_HEIGHT = 520;
const WINDOW_MARGIN = 12;
const bridgePaths = resolveBridgePaths(app.isPackaged, process.env.CHATGPT_BRIDGE_ROOT, __dirname);
const CLI_PATH = bridgePaths.ok ? bridgePaths.cliPath : "";
const REQUESTS_PATH = bridgePaths.ok ? bridgePaths.requestsPath : "";
const PROFILE_DIR = bridgePaths.ok ? bridgePaths.profileDir : "";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9]$/u;
const CONVERSATION_URL_PATTERN = /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+(?:[/?#][^\s]*)?$/u;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const LOG_TAIL_MAX_BYTES = 200 * 1024;
const DOCTOR_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 45_000;
const SUBMIT_TIMEOUT_MS = 60_000;
let tray: Tray | undefined;
let barWindow: BrowserWindow | undefined;
let popupOpen = false;
let isQuitting = false;
export interface WindowControlState { alwaysOnTop: boolean; muted: boolean; }
let windowControls: WindowControlState = { alwaysOnTop: true, muted: false };
let doctor = EMPTY_STATE.doctor;
let scannedRequests: Awaited<ReturnType<typeof scanRequests>> = [];
let bridgeState: BridgeGuiState = EMPTY_STATE;
let pickerAttachmentPaths = new Set<string>();

function rendererUrl(): string { return !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : `file://${path.join(__dirname, "../renderer/index.html")}`; }
function createTrayIcon() { return nativeImage.createFromPath(path.join(__dirname, "../../assets/tray-icon.png")).resize({ width: 16, height: 16 }); }
function positionWindow() {
  if (!barWindow) return;
  const height = popupOpen ? POPUP_HEIGHT : BAR_HEIGHT;
  const { workArea } = screen.getPrimaryDisplay();
  barWindow.setSize(BAR_WIDTH, height);
  barWindow.setPosition(workArea.x + workArea.width - BAR_WIDTH - WINDOW_MARGIN, workArea.y + workArea.height - height - WINDOW_MARGIN);
}
function showBar() {
  if (!barWindow) {
    barWindow = new BrowserWindow({ width: BAR_WIDTH, height: BAR_HEIGHT, useContentSize: true, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: windowControls.alwaysOnTop, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.js") } });
    void barWindow.loadURL(rendererUrl());
    barWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    barWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    barWindow.on("close", (event) => {
      if (isQuitting) return;
      event.preventDefault();
      barWindow?.hide();
    });
  }
  positionWindow();
  barWindow.show();
  barWindow.focus();
}
function toggleBar() { if (barWindow?.isVisible()) barWindow.hide(); else showBar(); }
function setAlwaysOnTop(alwaysOnTop: boolean): WindowControlState {
  windowControls = { ...windowControls, alwaysOnTop };
  barWindow?.setAlwaysOnTop(alwaysOnTop);
  return windowControls;
}
function toggleMute(): WindowControlState { windowControls = { ...windowControls, muted: !windowControls.muted }; return windowControls; }
function publishState() { bridgeState = aggregateState(doctor, scannedRequests); barWindow?.webContents.send("bridge-gui:state", bridgeState); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function stringValue(value: unknown): string | null { return typeof value === "string" ? value : null; }
function validRequestId(value: unknown): value is string { return typeof value === "string" && REQUEST_ID_PATTERN.test(value) && !value.includes(".."); }
function conversationUrl(value: unknown): string | null { return typeof value === "string" && CONVERSATION_URL_PATTERN.test(value) ? value : null; }
function safeRequestDirectory(requestId: unknown): string {
  if (!validRequestId(requestId)) throw new Error("Invalid request id");
  const requestDirectory = path.resolve(REQUESTS_PATH, requestId);
  if (!requestDirectory.startsWith(`${REQUESTS_PATH}${path.sep}`)) throw new Error("Invalid request path");
  return requestDirectory;
}
async function readOptionalJson(filePath: string): Promise<{ value: Record<string, unknown> | null; error?: string }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return { value: isRecord(parsed) ? parsed : null, ...(isRecord(parsed) ? {} : { error: "Malformed JSON" }) };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { value: null };
    return { value: null, error: error instanceof Error ? error.message : "Could not read JSON" };
  }
}
async function readOptionalText(filePath: string, maxBytes: number): Promise<{ content: string | null; truncated: boolean; error?: string }> {
  try {
    const handle = await open(filePath, "r");
    try {
      const { size } = await handle.stat();
      const bytes = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(bytes);
      await handle.read(buffer, 0, bytes, 0);
      return { content: buffer.toString("utf8"), truncated: size > maxBytes };
    } finally { await handle.close(); }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { content: null, truncated: false };
    return { content: null, truncated: false, error: error instanceof Error ? error.message : "Could not read file" };
  }
}
async function readOptionalTail(filePath: string): Promise<{ content: string | null; truncated: boolean; error?: string }> {
  try {
    const handle = await open(filePath, "r");
    try {
      const { size } = await handle.stat();
      const bytes = Math.min(size, LOG_TAIL_MAX_BYTES);
      const buffer = Buffer.alloc(bytes);
      await handle.read(buffer, 0, bytes, Math.max(0, size - bytes));
      let content = buffer.toString("utf8");
      if (size > bytes) content = content.slice(content.indexOf("\n") + 1);
      return { content, truncated: size > bytes };
    } finally { await handle.close(); }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { content: null, truncated: false };
    return { content: null, truncated: false, error: error instanceof Error ? error.message : "Could not read log" };
  }
}
export interface RequestDetail {
  requestId: string; status: string | null; error: string | null; conversationUrl: string | null;
  requestedPreset: string | null; observedPreset: string | null; requestedModel: string | null; observedModel: string | null;
  caller: string | null; project: string | null;
  prompt: string | null; response: string | null; responseTruncated: boolean; log: string | null; logTruncated: boolean;
  fieldErrors: Partial<Record<"request" | "result" | "meta" | "prompt" | "response" | "log", string>>;
}
export type StopRequestResult = { ok: true; requestId: string } | { ok: false; reason: string };
export type RefreshCookieResult = { ok: true } | { ok: false; reason: string };
export type SubmitNewResult = { ok: true; requestId: string } | { ok: false; reason: string };
async function readRequestDetail(requestId: unknown): Promise<RequestDetail> {
  const requestDirectory = safeRequestDirectory(requestId);
  const validatedRequestId = requestId as string;
  const [requestFile, resultFile, metaFile, promptFile, responseFile, logFile] = await Promise.all([
    readOptionalJson(path.join(requestDirectory, "request.json")), readOptionalJson(path.join(requestDirectory, "result.json")), readOptionalJson(path.join(requestDirectory, "meta.json")),
    readOptionalText(path.join(requestDirectory, "prompt.md"), 20_000), readOptionalText(path.join(requestDirectory, "response.md"), RESPONSE_MAX_BYTES), readOptionalTail(path.join(requestDirectory, "run.log")),
  ]);
  const request = requestFile.value ?? {};
  const result = resultFile.value ?? {};
  const meta = metaFile.value ?? {};
  const fieldErrors: RequestDetail["fieldErrors"] = {};
  for (const [name, file] of Object.entries({ request: requestFile, result: resultFile, meta: metaFile, prompt: promptFile, response: responseFile, log: logFile })) if (file.error) fieldErrors[name as keyof RequestDetail["fieldErrors"]] = file.error;
  return {
    requestId: validatedRequestId, status: stringValue(result.status), error: isRecord(result.error) ? stringValue(result.error.message) : null,
    conversationUrl: conversationUrl(result.conversationUrl) ?? conversationUrl(request.conversationUrl),
    requestedPreset: stringValue(result.requestedPreset) ?? stringValue(request.preset), observedPreset: stringValue(result.observedPreset),
    requestedModel: stringValue(result.requestedModel) ?? stringValue(request.model), observedModel: stringValue(result.observedModel),
    caller: stringValue(meta.caller), project: stringValue(meta.project), prompt: promptFile.content, response: responseFile.content,
    responseTruncated: responseFile.truncated, log: logFile.content, logTruncated: logFile.truncated, fieldErrors,
  };
}
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
function parseStop(stdout: string): StopRequestResult {
  const line = stdout.split(/\r?\n/u).find((candidate) => candidate.trim());
  if (!line) throw new Error("stop --json returned no JSON");
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed) || typeof parsed.ok !== "boolean") throw new Error("stop --json returned an unexpected shape");
  if (parsed.ok === true && validRequestId(parsed.requestId)) return { ok: true, requestId: parsed.requestId };
  if (parsed.ok === false && typeof parsed.reason === "string" && parsed.reason) return { ok: false, reason: parsed.reason };
  throw new Error("stop --json returned an unexpected shape");
}
function requestStop(requestId: string): Promise<StopRequestResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [CLI_PATH, "stop", requestId, "--json"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
    } catch (error) {
      resolve({ ok: false, reason: error instanceof Error ? `Could not start stop command: ${error.message}` : "Could not start stop command" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: StopRequestResult) => { if (!settled) { settled = true; if (timeout) clearTimeout(timeout); resolve(result); } };
    timeout = setTimeout(() => { child.kill(); finish({ ok: false, reason: "Stop command timed out" }); }, STOP_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ ok: false, reason: `Could not start stop command: ${error.message}` }));
    child.on("close", () => {
      if (settled) return;
      try { finish(parseStop(stdout)); }
      catch (error) {
        const reason = error instanceof Error ? error.message : "Malformed stop output";
        finish({ ok: false, reason: `${reason}${stderr.trim() ? ` (${stderr.trim()})` : ""}` });
      }
    });
  });
}
function parseSubmit(stdout: string): SubmitNewResult {
  const line = stdout.split(/\r?\n/u).find((candidate) => candidate.trim());
  if (!line) throw new Error("submit --json returned no JSON");
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) throw new Error("submit --json returned an unexpected shape");
  if (isRecord(parsed.error) && typeof parsed.error.message === "string" && parsed.error.message) return { ok: false, reason: parsed.error.message };
  if (validRequestId(parsed.requestId)) return { ok: true, requestId: parsed.requestId };
  throw new Error("submit --json returned an unexpected shape");
}
function requestSubmit(requestFilePath: string): Promise<SubmitNewResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, buildSubmitArgs(CLI_PATH, requestFilePath), { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
    } catch (error) {
      resolve({ ok: false, reason: error instanceof Error ? `Could not start submit: ${error.message}` : "Could not start submit" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: SubmitNewResult) => { if (!settled) { settled = true; if (timeout) clearTimeout(timeout); resolve(result); } };
    timeout = setTimeout(() => { child.kill(); finish({ ok: false, reason: "Submit command timed out" }); }, SUBMIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ ok: false, reason: `Could not start submit: ${error.message}` }));
    child.on("close", () => {
      if (settled) return;
      try { finish(parseSubmit(stdout)); }
      catch (error) {
        const reason = error instanceof Error ? error.message : "Malformed submit output";
        finish({ ok: false, reason: `${reason}${stderr.trim() ? ` (${stderr.trim()})` : ""}` });
      }
    });
  });
}
async function findChromeExecutable(): Promise<string | null> {
  const candidates = process.platform === "win32"
    ? [
        path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : ["/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; }
    catch { /* Try the next documented Chrome location. */ }
  }
  return null;
}
function requestRefreshCookie(): Promise<RefreshCookieResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [CLI_PATH, "doctor", "--json", "--no-login"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
    } catch (error) {
      resolve({ ok: false, reason: error instanceof Error ? `Could not start doctor: ${error.message}` : "Could not start doctor" });
      return;
    }
    let stdout = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: RefreshCookieResult) => { if (!settled) { settled = true; if (timeout) clearTimeout(timeout); resolve(result); } };
    timeout = setTimeout(() => { child.kill(); finish({ ok: false, reason: "Doctor preflight timed out" }); }, DOCTOR_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on("error", (error) => finish({ ok: false, reason: `Could not start doctor: ${error.message}` }));
    child.on("close", () => {
      if (settled) return;
      const preflight: RefreshCookiePreflightResult = evaluateRefreshCookiePreflight(stdout);
      if (!preflight.ok) { finish(preflight); return; }
      void findChromeExecutable().then((chromePath) => {
        if (!chromePath) { finish({ ok: false, reason: "Google Chrome could not be found" }); return; }
        try {
          const chrome = spawn(chromePath, [`--user-data-dir=${PROFILE_DIR}`, "https://chatgpt.com/"], { detached: true, stdio: "ignore" });
          chrome.unref();
          chrome.once("error", (error) => finish({ ok: false, reason: `Could not open Google Chrome: ${error.message}` }));
          chrome.once("spawn", () => finish({ ok: true }));
        } catch (error) {
          finish({ ok: false, reason: error instanceof Error ? `Could not open Google Chrome: ${error.message}` : "Could not open Google Chrome" });
        }
      }, (error) => finish({ ok: false, reason: error instanceof Error ? `Could not find Google Chrome: ${error.message}` : "Could not find Google Chrome" }));
    });
  });
}
function pollDoctor(): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, "doctor", "--json", "--no-login"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = () => { if (!settled) { settled = true; if (timeout) clearTimeout(timeout); resolve(); } };
    timeout = setTimeout(() => {
      child.kill();
      console.warn("Bridge GUI: doctor poll timed out; retrying next tick");
      doctor = { ok: false, items: [], error: "Doctor poll timed out" };
      publishState();
      finish();
    }, DOCTOR_TIMEOUT_MS);
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

if (hasSingleInstanceLock) {
  app.on("before-quit", () => { isQuitting = true; });
  app.on("second-instance", () => { if (bridgePaths.ok) void app.whenReady().then(showBar); });

  app.whenReady().then(() => {
    if (!bridgePaths.ok) {
      dialog.showErrorBox("ChatGPT Bridge root is not configured", bridgePaths.error);
      app.quit();
      return;
    }
    tray = new Tray(createTrayIcon());
    tray.setToolTip("ChatGPT Bridge Control");
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "Show", click: showBar }, { type: "separator" }, { label: "Quit", click: () => app.quit() }]));
    tray.on("click", showBar);
    ipcMain.on("bridge-gui:subscribe", (event) => event.sender.send("bridge-gui:state", bridgeState));
    ipcMain.on("bridge-gui:toggle-popup", () => { popupOpen = !popupOpen; positionWindow(); });
    ipcMain.handle("bridge-gui:window-controls", (): WindowControlState => windowControls);
    ipcMain.handle("bridge-gui:toggle-always-on-top", (): WindowControlState => setAlwaysOnTop(!windowControls.alwaysOnTop));
    ipcMain.handle("bridge-gui:toggle-mute", (): WindowControlState => toggleMute());
    ipcMain.handle("bridge-gui:get-autostart", (): boolean => {
      const portablePath = portableExecutablePath(process.env.PORTABLE_EXECUTABLE_FILE);
      return app.getLoginItemSettings(portablePath ? { path: portablePath } : undefined).openAtLogin;
    });
    ipcMain.handle("bridge-gui:set-autostart", (_event, openAtLogin: unknown): boolean => {
      if (typeof openAtLogin !== "boolean") throw new TypeError("openAtLogin must be a boolean");
      const portablePath = portableExecutablePath(process.env.PORTABLE_EXECUTABLE_FILE);
      app.setLoginItemSettings(portablePath ? { openAtLogin, path: portablePath } : { openAtLogin });
      return app.getLoginItemSettings(portablePath ? { path: portablePath } : undefined).openAtLogin;
    });
    ipcMain.handle("bridge-gui:request-detail", async (_event, requestId: unknown) => {
      try { return await readRequestDetail(requestId); }
      catch (error) { return { error: error instanceof Error ? error.message : "Could not load request detail" }; }
    });
    ipcMain.handle("bridge-gui:open-conversation", async (_event, requestId: unknown) => {
      try {
        const detail = await readRequestDetail(requestId);
        if (!detail.conversationUrl) return false;
        await shell.openExternal(detail.conversationUrl);
        return true;
      } catch { return false; }
    });
    ipcMain.handle("bridge-gui:stop", async (_event, requestId: unknown): Promise<StopRequestResult> => {
      if (!validRequestId(requestId)) return { ok: false, reason: "Invalid request id" };
      const running = bridgeState.requests.find((request) => request.requestId === requestId && request.status === "Running");
      if (!running) return { ok: false, reason: "Request is no longer running" };
      try {
        const options: MessageBoxOptions = {
          type: "warning",
          title: "Stop running request?",
          message: "Stop this running request?",
          detail: `Title: ${running.title}\nRequest ID: ${running.requestId}\n\nStopping is cooperative: the running process will stop after its next poll.`,
          buttons: ["Cancel", "Stop Request"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        };
        const confirmation = barWindow
          ? await dialog.showMessageBox(barWindow, options)
          : await dialog.showMessageBox(options);
        if (confirmation.response !== 1) return { ok: false, reason: "Stop cancelled" };
        return await requestStop(requestId);
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? `Could not request stop: ${error.message}` : "Could not request stop" };
      }
    });
    ipcMain.handle("bridge-gui:refresh-cookie", async (): Promise<RefreshCookieResult> => requestRefreshCookie());
    ipcMain.handle("bridge-gui:choose-new-attachments", async (): Promise<string[]> => {
      const result = barWindow
        ? await dialog.showOpenDialog(barWindow, { properties: ["openFile", "multiSelections"] })
        : await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
      return result.canceled ? [...pickerAttachmentPaths] : addPickerAttachmentPaths(pickerAttachmentPaths, result.filePaths);
    });
    ipcMain.handle("bridge-gui:submit-new", async (_event, value: NewSubmissionInput): Promise<SubmitNewResult> => {
      const validated = validateNewSubmission(value);
      if (!validated.ok) return validated;
      if (!attachmentsArePickerApproved(validated.value.attachments, pickerAttachmentPaths)) {
        pickerAttachmentPaths.clear();
        return { ok: false, reason: "Attachments must be selected with the file picker" };
      }
      pickerAttachmentPaths.clear();
      const requestId = createRequestId();
      let requestDirectory: string;
      try {
        requestDirectory = await writeNewRequest(REQUESTS_PATH, requestId, validated.value, fs);
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? `Could not create request files: ${error.message}` : "Could not create request files" };
      }
      return requestSubmit(path.join(requestDirectory, "request.json"));
    });
    void pollDoctor();
    void pollRequests();
    const hotkeyRegistered = globalShortcut.register("CommandOrControl+Shift+C", toggleBar);
    if (!hotkeyRegistered) console.warn("Bridge GUI: global hotkey CommandOrControl+Shift+C is already in use; continuing without it");
    setInterval(() => { void pollDoctor(); }, DOCTOR_POLL_INTERVAL_MS);
    setInterval(() => { void pollRequests(); }, REQUESTS_POLL_INTERVAL_MS);
  });

  app.on("will-quit", () => { globalShortcut.unregister("CommandOrControl+Shift+C"); });
}
