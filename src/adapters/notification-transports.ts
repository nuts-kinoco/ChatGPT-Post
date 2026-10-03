/** Optional host-only notification adapters. Nothing here registers or activates a destination.
 * Secrets and approved recipients belong to the host, never to HTTP input or durable records.
 * Prepared closures are single-use; the outbox must claim immediately before invoking send.
 */
import { lookup } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Agent, type RequestOptions, request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { performance } from "node:perf_hooks";
import { checkServerIdentity } from "node:tls";

export type NotificationSendOutcome = "delivered" | "not_sent_retryable" | "not_sent" | "uncertain";

export interface PreparedNotificationTransport {
  readonly deadlineAt?: number;
  send(text: string, signal: AbortSignal): Promise<NotificationSendOutcome>;
}

export type NotificationTextInput =
  | { kind: "test" }
  | {
      kind: "human_check";
      category: "AUTH_REQUIRED" | "CAPTCHA_OR_CHALLENGE";
      requestId: string;
      conversationUrl?: string | null;
    };

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9]$/;
const CHAT_REFERENCE = /^https:\/\/chatgpt\.com\/c\/([A-Za-z0-9-]{1,128})$/;
const WEBHOOK = /^https:\/\/discord\.com(\/api\/webhooks\/[0-9]{1,24}\/[A-Za-z0-9_-]{1,128})$/;
const TEST_TEXT = "Bridge notification test. No task content is included.";
const AUTH_TEXT = "Bridge needs your attention: ChatGPT sign-in is required.";
const CAPTCHA_TEXT = "Bridge needs your attention: ChatGPT requires a human check.";

/** Validate the original bytes, then rebuild. URL normalization must not hide ambiguity. */
export function canonicalChatReference(url: string): string | null {
  if (typeof url !== "string" || url.length > 151) return null;
  const match = CHAT_REFERENCE.exec(url);
  return match ? `https://chatgpt.com/c/${match[1]}` : null;
}

/** Only immutable trusted event identifiers belong here. Extra input fields are never copied. */
export function buildNotificationText(input: NotificationTextInput): string | null {
  if (input.kind === "test") return TEST_TEXT;
  if (
    input.kind !== "human_check" ||
    typeof input.requestId !== "string" ||
    !REQUEST_ID.test(input.requestId) ||
    (input.category !== "AUTH_REQUIRED" && input.category !== "CAPTCHA_OR_CHALLENGE")
  ) {
    return null;
  }
  const reference =
    input.conversationUrl == null ? null : canonicalChatReference(input.conversationUrl);
  if (input.conversationUrl != null && reference === null) return null;
  return `${input.category === "AUTH_REQUIRED" ? AUTH_TEXT : CAPTCHA_TEXT}\nRequest: ${input.requestId}${reference ? `\nChat: ${reference}` : ""}`;
}

function safeText(text: string): boolean {
  if (typeof text !== "string" || text.length > 384) return false;
  if (text === TEST_TEXT) return true;
  const [heading, requestLine, chatLine, extra] = text.split("\n");
  if (extra !== undefined || (heading !== AUTH_TEXT && heading !== CAPTCHA_TEXT)) return false;
  if (!requestLine?.startsWith("Request: ")) return false;
  const requestId = requestLine.slice(9);
  if (!REQUEST_ID.test(requestId)) return false;
  if (chatLine === undefined) return true;
  return chatLine.startsWith("Chat: ") && canonicalChatReference(chatLine.slice(6)) !== null;
}

/** One monotonic budget covers secret resolution, DNS, connection/TLS and all response bytes. */
class TransportBudget {
  readonly controller = new AbortController();
  readonly deadlineAt: number;
  private readonly monotonicDeadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly unlink: (() => void)[] = [];

  constructor(signal: AbortSignal, timeoutMs: number) {
    this.deadlineAt = Date.now() + timeoutMs;
    this.monotonicDeadline = performance.now() + timeoutMs;
    this.timer = setTimeout(() => this.close(), timeoutMs);
    this.link(signal);
  }

  link(signal: AbortSignal): void {
    if (signal.aborted) this.close();
    else {
      const abort = () => this.close();
      signal.addEventListener("abort", abort, { once: true });
      this.unlink.push(() => signal.removeEventListener("abort", abort));
    }
  }

  get expired(): boolean {
    if (performance.now() >= this.monotonicDeadline) this.close();
    return this.controller.signal.aborted;
  }

  close(): void {
    clearTimeout(this.timer);
    this.controller.abort();
    for (const unlink of this.unlink.splice(0)) unlink();
  }

  run<T>(operation: () => Promise<T>): Promise<T | null> {
    if (this.expired) return Promise.resolve(null);
    return new Promise((resolve) => {
      const signal = this.controller.signal;
      let settled = false;
      const finish = (value: T | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => finish(null);
      signal.addEventListener("abort", abort, { once: true });
      try {
        // Invoke synchronously: there is no hidden await before a prepared transport's effect.
        Promise.resolve(operation()).then(
          (value) => finish(value),
          () => finish(null),
        );
      } catch {
        finish(null);
      }
    });
  }
}

function budget(signal: AbortSignal, timeoutMs = 10_000): TransportBudget | null {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return null;
  return new TransportBudget(signal, timeoutMs);
}

function isOutcome(value: unknown): value is NotificationSendOutcome {
  return (
    value === "delivered" ||
    value === "not_sent" ||
    value === "not_sent_retryable" ||
    value === "uncertain"
  );
}

function prepared(
  scope: TransportBudget,
  effect: (text: string, signal: AbortSignal) => Promise<NotificationSendOutcome>,
): PreparedNotificationTransport {
  let used = false;
  return Object.freeze({
    deadlineAt: scope.deadlineAt,
    send(text: string, signal: AbortSignal): Promise<NotificationSendOutcome> {
      if (used) return Promise.resolve("not_sent");
      used = true;
      scope.link(signal);
      if (!safeText(text) || scope.expired) {
        scope.close();
        return Promise.resolve("not_sent");
      }
      return scope
        .run(() => effect(text, scope.controller.signal))
        .then(
          (outcome): NotificationSendOutcome =>
            !scope.expired && isOutcome(outcome) ? outcome : "uncertain",
        )
        .finally(() => scope.close());
    },
  });
}

export interface EmailNotificationTransportOptions {
  /** Host resolves credentials and returns a sender already bound to ONE approved recipient.
   * The port must not retry. Only authoritative rejection can return not_sent_retryable.
   * Neither a recipient nor a mail server can be supplied through send or HTTP input.
   */
  resolveSender(signal: AbortSignal): Promise<PreparedNotificationTransport | null>;
  totalTimeoutMs?: number;
}

export async function prepareEmailNotificationTransport(
  options: EmailNotificationTransportOptions,
  signal: AbortSignal,
): Promise<PreparedNotificationTransport | null> {
  const scope = budget(signal, options.totalTimeoutMs);
  if (!scope) return null;
  try {
    const sender = await scope.run(() => options.resolveSender(scope.controller.signal));
    if (!sender || typeof sender.send !== "function" || scope.expired) {
      scope.close();
      return null;
    }
    const send = sender.send.bind(sender);
    return prepared(scope, (text, sendSignal) => send(text, sendSignal));
  } catch {
    scope.close();
    return null;
  }
}

export interface NotificationAddress {
  address: string;
  family: 4 | 6;
}
export interface DiscordNotificationTransportOptions {
  /** Secure host-owned read; never expose the resulting URL through a status or diagnostic. */
  readWebhook(signal: AbortSignal): Promise<string | null>;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
  /** Host-only seams for deterministic tests. These are not HTTP/user-supplied callbacks. */
  resolveAddresses?(
    hostname: "discord.com",
    signal: AbortSignal,
  ): Promise<readonly NotificationAddress[]>;
  httpsRequest?(
    options: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ): ClientRequest;
}

/** Conservative global-unicast allow policy; special-purpose ranges fail closed. */
function publicAddress(value: NotificationAddress): boolean {
  if (typeof value.address !== "string" || value.address.length > 45) return false;
  if (isIP(value.address) !== value.family) return false;
  if (value.family === 4) {
    const [a = 0, b = 0, c = 0] = value.address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (value.family !== 6 || value.address.includes("%") || value.address.includes("."))
    return false;
  const halves = value.address.toLowerCase().split("::");
  const first = halves[0] ? halves[0].split(":") : [];
  const last = halves[1] ? halves[1].split(":") : [];
  const parts =
    halves.length === 2
      ? [...first, ...Array(8 - first.length - last.length).fill("0"), ...last]
      : first;
  const a = Number.parseInt(parts[0] ?? "0", 16);
  const b = Number.parseInt(parts[1] ?? "0", 16);
  return (
    a >= 0x2000 &&
    a <= 0x3fff &&
    !(a === 0x2001 && (b <= 0x1ff || b === 0xdb8)) &&
    a !== 0x2002 &&
    !(a === 0x3fff && b <= 0x0fff)
  );
}

function pinnedLookup(address: NotificationAddress): LookupFunction {
  return (hostname, options, callback) => {
    if (hostname !== "discord.com") {
      callback(new Error("notification_lookup_denied"), "", 4);
      return;
    }
    if (options.all) callback(null, [{ ...address }]);
    else callback(null, address.address, address.family);
  };
}

function sendDiscord(
  path: string,
  address: NotificationAddress,
  text: string,
  signal: AbortSignal,
  responseLimit: number,
  httpsRequest: NonNullable<DiscordNotificationTransportOptions["httpsRequest"]>,
): Promise<NotificationSendOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let outgoing: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    // An isolated agent cannot inherit the process's global proxy, reused connection or TLS state.
    const agent = new Agent({
      keepAlive: false,
      maxSockets: 1,
      maxTotalSockets: 1,
      maxCachedSessions: 0,
      proxyEnv: {},
    });
    const finish = (outcome: NotificationSendOutcome) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      outgoing?.destroy();
      incoming?.destroy();
      agent.destroy();
      resolve(outcome);
    };
    const abort = () => finish("uncertain");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      finish("not_sent");
      return;
    }
    const body = JSON.stringify({
      content: text,
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    });
    try {
      outgoing = httpsRequest(
        {
          protocol: "https:",
          hostname: "discord.com",
          port: 443,
          path,
          method: "POST",
          servername: "discord.com",
          rejectUnauthorized: true,
          checkServerIdentity,
          agent,
          lookup: pinnedLookup(address),
          family: address.family,
          maxHeaderSize: 8192,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "user-agent": "bridge-notifications/1",
            connection: "close",
          },
        },
        (response) => {
          incoming = response;
          let bytes = 0;
          response.on("error", () => finish("uncertain"));
          response.on("aborted", () => finish("uncertain"));
          response.on("close", () => {
            if (!response.complete) finish("uncertain");
          });
          response.on("data", (chunk: unknown) => {
            if (!Buffer.isBuffer(chunk) && typeof chunk !== "string") {
              finish("uncertain");
              return;
            }
            bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
            if (bytes > responseLimit) finish("uncertain");
          });
          response.on("end", () => {
            if (!response.complete) {
              finish("uncertain");
              return;
            }
            const status = response.statusCode;
            if (status === 200 || status === 204) finish("delivered");
            else if (status === 429) finish("not_sent_retryable");
            else if (
              status === 400 ||
              status === 401 ||
              status === 403 ||
              status === 404 ||
              status === 405 ||
              status === 413
            )
              finish("not_sent");
            else finish("uncertain");
          });
          if (settled) response.destroy();
        },
      );
      outgoing.on("error", () => finish("uncertain"));
      if (settled || signal.aborted) {
        outgoing.destroy();
        finish("uncertain");
        return;
      }
      outgoing.end(body);
    } catch {
      finish("uncertain");
    }
  });
}

export async function prepareDiscordNotificationTransport(
  options: DiscordNotificationTransportOptions,
  signal: AbortSignal,
): Promise<PreparedNotificationTransport | null> {
  const scope = budget(signal, options.totalTimeoutMs);
  if (!scope) return null;
  try {
    const httpsRequest = options.httpsRequest ?? request;
    const responseLimit = options.maxResponseBytes ?? 8192;
    if (!Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseLimit > 65_536) {
      scope.close();
      return null;
    }
    const secret = await scope.run(() => options.readWebhook(scope.controller.signal));
    if (typeof secret !== "string" || secret.length > 200 || scope.expired) {
      scope.close();
      return null;
    }
    const path = WEBHOOK.exec(secret)?.[1];
    if (!path) {
      scope.close();
      return null;
    }
    const addresses = await scope.run(() =>
      options.resolveAddresses
        ? options.resolveAddresses("discord.com", scope.controller.signal)
        : (lookup("discord.com", { all: true, verbatim: true }) as Promise<NotificationAddress[]>),
    );
    if (
      !Array.isArray(addresses) ||
      addresses.length < 1 ||
      addresses.length > 16 ||
      scope.expired
    ) {
      scope.close();
      return null;
    }
    // Copy before checking so even a host seam's mutable records cannot change a checked value.
    const checked = addresses.map((value: NotificationAddress) => ({
      address: value.address,
      family: value.family,
    }));
    if (checked.some((address) => !publicAddress(address))) {
      scope.close();
      return null;
    }
    const address = checked[0] as NotificationAddress;
    return prepared(scope, (text, sendSignal) =>
      sendDiscord(path, address, text, sendSignal, responseLimit, httpsRequest),
    );
  } catch {
    scope.close();
    return null;
  }
}
