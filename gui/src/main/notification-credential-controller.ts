/** Pure host-only predicates. Nothing here imports Electron, reads storage, or sends a notification. */
export const NOTIFICATION_CREDENTIAL_SCHEME = "bridge-notification-credential";
export const NOTIFICATION_CREDENTIAL_URL = `${NOTIFICATION_CREDENTIAL_SCHEME}://dialog/index.html`;
export const NOTIFICATION_CREDENTIAL_CHANNELS = Object.freeze({
  view: "bridge-notification-credential:view",
  submit: "bridge-notification-credential:submit",
  cancel: "bridge-notification-credential:cancel",
});
export const NOTIFICATION_CREDENTIAL_SESSION_MS = 10 * 60 * 1000;
export interface NotificationCredentialView {
  label: string;
  channel: "discord" | "email";
  hasRecord: boolean;
  expectedTarget: string | null;
  leaseLifetimeMs: number;
}
export type NotificationCredentialSubmission =
  | { mode: "register"; secret: string; consent: true }
  | { mode: "replace"; secret: string; consent?: boolean }
  | { mode: "unlock" };
export interface NotificationCredentialRequest {
  view: NotificationCredentialView;
  submit(value: unknown): void;
  cancel(): void;
}
export interface NotificationCredentialEvent {
  sender: { session: unknown; mainFrame: unknown };
  senderFrame: { url: string } | null;
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function safeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value, "utf8").toString("utf8") === value;
}
function validView(value: unknown): value is NotificationCredentialView {
  if (!plainRecord(value) || Object.keys(value).sort().join(",") !== "channel,expectedTarget,hasRecord,label,leaseLifetimeMs") return false;
  return safeText(value.label, 160) && (value.channel === "discord" || value.channel === "email")
    && typeof value.hasRecord === "boolean" && (value.expectedTarget === null || safeText(value.expectedTarget, 256))
    && Number.isSafeInteger(value.leaseLifetimeMs) && (value.leaseLifetimeMs as number) >= 60_000
    && (value.leaseLifetimeMs as number) <= 24 * 60 * 60 * 1000;
}
function parseSubmission(value: unknown, hasRecord: boolean): NotificationCredentialSubmission | null {
  if (!plainRecord(value) || Object.keys(value).some(key => !["mode", "secret", "consent"].includes(key))) return null;
  if (value.mode === "unlock") return hasRecord && Object.keys(value).length === 1 ? {mode: "unlock"} : null;
  if (value.mode !== (hasRecord ? "replace" : "register")) return null;
  if (!safeText(value.secret, 8192) || Buffer.byteLength(value.secret, "utf8") > 8192) return null;
  if ("consent" in value && typeof value.consent !== "boolean") return null;
  if (value.mode === "register") return value.consent === true ? {mode: "register", secret: value.secret, consent: true} : null;
  return {mode: "replace", secret: value.secret, ...("consent" in value ? {consent: value.consent as boolean} : {})};
}

export function validateNotificationCredentialView(value: unknown): value is NotificationCredentialView {
  try { return validView(value); } catch { return false; }
}
export function notificationCredentialSubmission(value: unknown, hasRecord: boolean): NotificationCredentialSubmission | null {
  try { return parseSubmission(value, hasRecord); } catch { return null; }
}

export function createNotificationCredentialController(options: {
  request: NotificationCredentialRequest;
  sender: NotificationCredentialEvent["sender"];
  session: unknown;
  mainFrame: unknown;
  wallNow?: () => number;
  monotonicNow?: () => number;
  dispose(): void;
}) {
  let view: Readonly<NotificationCredentialView>;
  try {
    view = Object.freeze({...options.request.view});
    if (!validateNotificationCredentialView(view)) throw new Error();
  } catch { throw new Error("notification_credential_view_rejected"); }
  const wallNow = options.wallNow ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const wallStart = wallNow(), monotonicStart = monotonicNow();
  let lastWall = wallStart, lastMonotonic = monotonicStart;
  let live = true, submitted = false;
  let mainFrame = options.mainFrame;
  let committed = false;
  function close() {
    if (!live) return;
    live = false;
    options.dispose();
  }
  function cancel() {
    if (!live) return;
    // Revoke callbacks before invoking the provider or destroying the renderer.
    live = false;
    try { options.request.cancel(); } catch { /* Never expose provider errors to IPC or event diagnostics. */ } finally { options.dispose(); }
  }
  function active(): boolean {
    if (!live) return false;
    const wall = wallNow(), mono = monotonicNow();
    if (!Number.isFinite(wall) || !Number.isFinite(mono) || wall < lastWall || mono < lastMonotonic
      || wall - wallStart >= NOTIFICATION_CREDENTIAL_SESSION_MS || mono - monotonicStart >= NOTIFICATION_CREDENTIAL_SESSION_MS) {
      cancel(); return false;
    }
    lastWall = wall; lastMonotonic = mono;
    return true;
  }
  function trusted(event: NotificationCredentialEvent): boolean {
    try {
      return active() && event.sender === options.sender && event.sender.session === options.session
        && !!event.senderFrame && event.senderFrame === mainFrame && event.sender.mainFrame === mainFrame
        && event.senderFrame.url === NOTIFICATION_CREDENTIAL_URL;
    } catch { return false; }
  }
  return {
    close, cancel, active,
    /** Only the initial exact packaged main-frame commit may establish frame identity. */
    didNavigate(url: string, frame: unknown) {
      if (!live) return;
      if (committed || url !== NOTIFICATION_CREDENTIAL_URL || !frame) { cancel(); return; }
      mainFrame = frame; committed = true;
    },
    view(event: NotificationCredentialEvent, args: readonly unknown[]) {
      return args.length === 0 && trusted(event) && !submitted ? {...view} : null;
    },
    submit(event: NotificationCredentialEvent, args: readonly unknown[]): boolean {
      if (args.length !== 1 || !trusted(event) || submitted) return false;
      const value = notificationCredentialSubmission(args[0], view.hasRecord);
      if (!value) return false;
      submitted = true;
      try { options.request.submit(value); }
      catch { cancel(); return false; }
      // The provider owns commit/error status; the renderer must never retain entered values.
      close();
      return true;
    },
    cancelFrom(event: NotificationCredentialEvent, args: readonly unknown[]): boolean {
      if (args.length !== 0 || !trusted(event)) return false;
      cancel(); return true;
    },
  };
}
