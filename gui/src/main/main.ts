import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, net, Tray, nativeImage, protocol, screen, shell, type MessageBoxOptions } from "electron";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { aggregateState, DOCTOR_POLL_INTERVAL_MS, EMPTY_STATE, REQUESTS_POLL_INTERVAL_MS, scanRequests, type BridgeGuiState, type DoctorItem } from "./state.js";
import { evaluateRefreshCookiePreflight, type RefreshCookiePreflightResult } from "./refresh-cookie.js";
import { addPickerAttachmentPaths, attachmentsArePickerApproved, buildSubmitArgs, createRequestId, validateNewSubmission, writeNewRequest, type NewSubmissionInput } from "./submit-new.js";
import { resolveBridgePaths } from "./bridge-paths.js";
import { describeCliRun, runBridgeCli } from "./cli-process.js";
import { portableExecutablePath } from "./login-item.js";
import { startPollLoop } from "./poll-loop.js";
import { RENDERER_SCHEME, rendererFilePath, resolveRendererUrl } from "./renderer-protocol.js";
import { bottomRightPosition, clampToWorkArea, isSavedPositionValid, popupBoundsForAnchor, type WindowBounds, type WindowPosition } from "./bar-position.js";
import * as fs from "node:fs/promises";

protocol.registerSchemesAsPrivileged([
  { scheme: RENDERER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

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
// The CLI runs in this executable with ELECTRON_RUN_AS_NODE, which loads ICU data from beside it (not bundled on macOS).
const EXEC_PATH_SIBLINGS = process.platform === "darwin" ? [] : ["icudtl.dat"];
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
let savedBarPosition: WindowPosition | undefined;
// The collapsed bar's location.  This deliberately remains independent from
// the expanded popup's bounds, which may need edge clamping.
let barAnchorPosition: WindowPosition | undefined;
let loadingBarPosition: Promise<void> | undefined;
let saveBarPositionTimeout: NodeJS.Timeout | undefined;
let lastProgrammaticBounds: WindowBounds | undefined;

function rendererUrl(): string { return resolveRendererUrl(app.isPackaged, process.env.ELECTRON_RENDERER_URL); }
function registerRendererProtocol() {
  const rendererDirectory = path.join(__dirname, "../renderer");
  protocol.handle(RENDERER_SCHEME, (request) => {
    const filePath = rendererFilePath(request.url, rendererDirectory);
    if (process.env.BRIDGE_GUI_DEBUG) console.log("[protocol]", request.url, "->", filePath);
    if (!filePath) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
}
function createTrayIcon() { return nativeImage.createFromPath(path.join(__dirname, "../../assets/tray-icon.png")).resize({ width: 16, height: 16 }); }
function barPositionFilePath() { return path.join(app.getPath("userData"), "bar-position.json"); }
function isWindowPosition(value: unknown): value is WindowPosition {
  return isRecord(value) && typeof value.x === "number" && Number.isFinite(value.x) && typeof value.y === "number" && Number.isFinite(value.y);
}
async function loadBarPosition() {
  if (loadingBarPosition) return loadingBarPosition;
  loadingBarPosition = (async () => {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(barPositionFilePath(), "utf8"));
      if (isWindowPosition(parsed)) savedBarPosition = parsed;
    } catch (error) {
      if (isRecord(error) && error.code !== "ENOENT") console.warn("Bridge GUI: could not load saved bar position", error);
    }
  })();
  return loadingBarPosition;
}
async function writeBarPosition(position: WindowPosition) {
  const filePath = barPositionFilePath();
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(temporaryPath, `${JSON.stringify(position)}\n`, "utf8");
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    console.warn("Bridge GUI: could not save bar position", error);
    try { await fs.rm(temporaryPath, { force: true }); } catch { /* Best-effort cleanup only. */ }
  }
}
function rememberBarPosition(position: WindowPosition) {
  barAnchorPosition = position;
  savedBarPosition = position;
  if (saveBarPositionTimeout) clearTimeout(saveBarPositionTimeout);
  saveBarPositionTimeout = setTimeout(() => {
    saveBarPositionTimeout = undefined;
    if (savedBarPosition) void writeBarPosition(savedBarPosition);
  }, 250);
}
function sameBounds(first: WindowBounds, second: WindowBounds) {
  return first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height;
}
function currentWorkAreas() { return screen.getAllDisplays().map(({ workArea }) => workArea); }
function applyWindowBounds(bounds: WindowBounds) {
  if (!barWindow) return;
  lastProgrammaticBounds = bounds;
  barWindow.setBounds(bounds);
}
function anchorPosition(): WindowPosition {
  if (!barWindow) throw new Error("Bridge GUI bar window is unavailable");
  const currentBounds = barWindow.getBounds();
  const candidate = barAnchorPosition ?? { x: currentBounds.x, y: currentBounds.y };
  const display = screen.getDisplayMatching({ ...candidate, width: BAR_WIDTH, height: BAR_HEIGHT });
  const clamped = clampToWorkArea({ ...candidate, width: BAR_WIDTH, height: BAR_HEIGHT }, display.workArea);
  const position = { x: clamped.x, y: clamped.y };
  if (candidate.x !== position.x || candidate.y !== position.y) rememberBarPosition(position);
  else barAnchorPosition = position;
  return position;
}
function positionWindow(): WindowBounds | undefined {
  if (!barWindow) return undefined;
  const anchor = anchorPosition();
  const display = screen.getDisplayMatching({ ...anchor, width: BAR_WIDTH, height: BAR_HEIGHT });
  const bounds = popupOpen
    ? popupBoundsForAnchor(anchor, BAR_WIDTH, POPUP_HEIGHT, display.workArea)
    : { ...anchor, width: BAR_WIDTH, height: BAR_HEIGHT };
  if (!sameBounds(barWindow.getBounds(), bounds)) applyWindowBounds(bounds);
  return bounds;
}
function ensureWindowIsOnOneDisplay() {
  if (!barWindow) return;
  positionWindow();
}
function onBarMoved() {
  if (!barWindow) return;
  const bounds = barWindow.getBounds();
  if (lastProgrammaticBounds && sameBounds(bounds, lastProgrammaticBounds)) {
    lastProgrammaticBounds = undefined;
    return;
  }
  const display = screen.getDisplayMatching(bounds);
  // A user may drag the visible header while the popup is edge-clamped.  Save
  // the header's requested location as a collapsed bar position, then derive
  // a separate, fully contained popup rectangle from that anchor.
  const clampedAnchor = clampToWorkArea({ x: bounds.x, y: bounds.y, width: BAR_WIDTH, height: BAR_HEIGHT }, display.workArea);
  rememberBarPosition({ x: clampedAnchor.x, y: clampedAnchor.y });
  positionWindow();
}
async function showBar() {
  if (!barWindow) {
    await loadBarPosition();
    if (!barWindow) {
      const primaryWorkArea = screen.getPrimaryDisplay().workArea;
      const initialPosition = savedBarPosition && isSavedPositionValid(savedBarPosition, BAR_WIDTH, BAR_HEIGHT, currentWorkAreas())
        ? savedBarPosition
        : bottomRightPosition(primaryWorkArea, BAR_WIDTH, BAR_HEIGHT, WINDOW_MARGIN);
      barAnchorPosition = initialPosition;
      barWindow = new BrowserWindow({ width: BAR_WIDTH, height: BAR_HEIGHT, x: initialPosition.x, y: initialPosition.y, useContentSize: true, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: windowControls.alwaysOnTop, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.cjs") } });
      if (process.env.BRIDGE_GUI_DEBUG) {
        const wc = barWindow.webContents;
        console.log("[debug] rendererUrl =", rendererUrl());
        wc.on("console-message", (e) => console.log("[renderer console]", e.level, e.message, e.sourceId, e.lineNumber));
        wc.on("did-fail-load", (_e, code, desc, url) => console.log("[did-fail-load]", code, desc, url));
        wc.on("preload-error", (_e, p, err) => console.log("[preload-error]", p, err));
        wc.on("render-process-gone", (_e, d) => console.log("[render-process-gone]", d));
        wc.on("did-finish-load", () => console.log("[did-finish-load]", wc.getURL()));
      }
      void barWindow.loadURL(rendererUrl());
      barWindow.webContents.on("will-navigate", (event) => event.preventDefault());
      barWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      barWindow.on("moved", onBarMoved);
      barWindow.on("close", (event) => {
        if (isQuitting) return;
        event.preventDefault();
        barWindow?.hide();
      });
    }
  }
  // Windows can create a hidden tool window as iconic.  Give it a normal show
  // state before applying its final bounds; bounds changes while iconic stay at
  // the Win32 (-32000, -32000) minimized sentinel position.
  if (barWindow.isMinimized()) barWindow.restore();
  barWindow.show();
  positionWindow();
  barWindow.focus();
}
function toggleBar() { if (barWindow?.isVisible()) barWindow.hide(); else void showBar(); }
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
async function requestStop(requestId: string): Promise<StopRequestResult> {
  const result = await runBridgeCli({ execPath: process.execPath, execPathSiblings: EXEC_PATH_SIBLINGS, cliPath: CLI_PATH, args: ["stop", requestId, "--json"], timeoutMs: STOP_TIMEOUT_MS, label: "stop command" });
  if (!result.ok) return result;
  try { return parseStop(result.run.stdout); }
  catch (error) { return { ok: false, reason: `${error instanceof Error ? error.message : "Malformed stop output"} (${describeCliRun(result.run)})` }; }
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
async function requestSubmit(requestFilePath: string): Promise<SubmitNewResult> {
  const [cliPath, ...args] = buildSubmitArgs(CLI_PATH, requestFilePath);
  const result = await runBridgeCli({ execPath: process.execPath, execPathSiblings: EXEC_PATH_SIBLINGS, cliPath, args, timeoutMs: SUBMIT_TIMEOUT_MS, label: "submit" });
  if (!result.ok) return result;
  try { return parseSubmit(result.run.stdout); }
  catch (error) { return { ok: false, reason: `${error instanceof Error ? error.message : "Malformed submit output"} (${describeCliRun(result.run)})` }; }
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
async function requestRefreshCookie(): Promise<RefreshCookieResult> {
  const doctorRun = await runBridgeCli({ execPath: process.execPath, execPathSiblings: EXEC_PATH_SIBLINGS, cliPath: CLI_PATH, args: ["doctor", "--json", "--no-login"], timeoutMs: DOCTOR_TIMEOUT_MS, label: "doctor preflight" });
  if (!doctorRun.ok) return doctorRun;
  const preflight: RefreshCookiePreflightResult = evaluateRefreshCookiePreflight(doctorRun.run.stdout, describeCliRun(doctorRun.run));
  if (!preflight.ok) return preflight;
  let chromePath: string | null;
  try { chromePath = await findChromeExecutable(); }
  catch (error) { return { ok: false, reason: error instanceof Error ? `Could not find Google Chrome: ${error.message}` : "Could not find Google Chrome" }; }
  if (!chromePath) return { ok: false, reason: "Google Chrome could not be found" };
  return new Promise((resolve) => {
    try {
      const chrome = spawn(chromePath, [`--user-data-dir=${PROFILE_DIR}`, "https://chatgpt.com/"], { detached: true, stdio: "ignore" });
      chrome.unref();
      chrome.once("error", (error) => resolve({ ok: false, reason: `Could not open Google Chrome: ${error.message}` }));
      chrome.once("spawn", () => resolve({ ok: true }));
    } catch (error) {
      resolve({ ok: false, reason: error instanceof Error ? `Could not open Google Chrome: ${error.message}` : "Could not open Google Chrome" });
    }
  });
}
async function pollDoctor(): Promise<void> {
  const result = await runBridgeCli({ execPath: process.execPath, execPathSiblings: EXEC_PATH_SIBLINGS, cliPath: CLI_PATH, args: ["doctor", "--json", "--no-login"], timeoutMs: DOCTOR_TIMEOUT_MS, label: "doctor poll" });
  if (!result.ok) {
    console.warn(`Bridge GUI: ${result.reason}; retrying next tick`);
    doctor = { ok: false, items: [], error: result.reason };
  } else {
    try { doctor = parseDoctor(result.run.stdout); }
    catch (error) {
      const reason = `${error instanceof Error ? error.message : "Malformed doctor output"} (${describeCliRun(result.run)})`;
      console.warn(`Bridge GUI: doctor output could not be parsed; retrying next tick: ${reason}${result.run.stderr.trim() ? `\n${result.run.stderr.trim()}` : ""}`);
      doctor = { ok: false, items: [], error: reason };
    }
  }
  publishState();
}
async function pollRequests() { scannedRequests = await scanRequests(REQUESTS_PATH); publishState(); }

if (hasSingleInstanceLock) {
  app.on("before-quit", () => { isQuitting = true; });
  app.on("second-instance", () => { if (bridgePaths.ok) void app.whenReady().then(showBar); });

  app.whenReady().then(() => {
    registerRendererProtocol();
    if (!bridgePaths.ok) {
      dialog.showErrorBox("ChatGPT Bridge root is not configured", bridgePaths.error);
      app.quit();
      return;
    }
    tray = new Tray(createTrayIcon());
    tray.setToolTip("ChatGPT Bridge Control");
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "Show", click: () => void showBar() }, { type: "separator" }, { label: "Quit", click: () => app.quit() }]));
    tray.on("click", () => void showBar());
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
    const hotkeyRegistered = globalShortcut.register("CommandOrControl+Shift+C", toggleBar);
    if (!hotkeyRegistered) console.warn("Bridge GUI: global hotkey CommandOrControl+Shift+C is already in use; continuing without it");
    startPollLoop(pollDoctor, DOCTOR_POLL_INTERVAL_MS);
    startPollLoop(pollRequests, REQUESTS_POLL_INTERVAL_MS);
    screen.on("display-metrics-changed", ensureWindowIsOnOneDisplay);
    screen.on("display-added", ensureWindowIsOnOneDisplay);
    screen.on("display-removed", ensureWindowIsOnOneDisplay);
  });

  app.on("will-quit", () => { globalShortcut.unregister("CommandOrControl+Shift+C"); });
}
