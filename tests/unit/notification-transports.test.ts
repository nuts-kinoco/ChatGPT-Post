/** Fake DNS and HTTPS only. The native request/lookup functions are forbidden in this suite. */
import { lookup } from "node:dns/promises";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { type Agent, type RequestOptions, request } from "node:https";
import { checkServerIdentity } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildNotificationText,
  canonicalChatReference,
  type DiscordNotificationTransportOptions,
  type NotificationAddress,
  type NotificationSendOutcome,
  type NotificationTextInput,
  prepareDiscordNotificationTransport,
  prepareEmailNotificationTransport,
} from "../../src/adapters/notification-transports.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(() => {
    throw new Error("network_forbidden");
  }),
}));
vi.mock("node:https", async (original) => ({
  ...(await original<typeof import("node:https")>()),
  request: vi.fn(() => {
    throw new Error("network_forbidden");
  }),
}));

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const CHAT = "https://chatgpt.com/c/test-conversation";
// Synthetic credentials only. Test labels/assertions never reflect even these token bytes.
const WEBHOOK = `https://discord.com/api/webhooks/123456789/${"x".repeat(64)}`;
const PUBLIC: NotificationAddress[] = [{ address: "162.159.128.233", family: 4 }];
const TEXT = buildNotificationText({ kind: "test" }) as string;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FakeResponse extends EventEmitter {
  complete = false;
  statusCode = 204;
  destroyed = false;
  destroy() {
    this.destroyed = true;
    return this;
  }
}
class FakeRequest extends EventEmitter {
  destroyed = false;
  body: string | undefined;
  constructor(private readonly onEnd: () => void) {
    super();
  }
  destroy() {
    this.destroyed = true;
    return this;
  }
  end(body: string) {
    this.body = body;
    this.onEnd();
    return this;
  }
}
function fakeHttps(autoRespond = true) {
  const records: { options: RequestOptions; request: FakeRequest; response: FakeResponse }[] = [];
  let respond:
    | ((status: number, chunks?: (Buffer | string)[], complete?: boolean) => void)
    | undefined;
  const httpsRequest: NonNullable<DiscordNotificationTransportOptions["httpsRequest"]> = (
    options,
    callback,
  ) => {
    const response = new FakeResponse();
    const sendResponse = (status: number, chunks: (Buffer | string)[] = [], complete = true) => {
      response.statusCode = status;
      callback(response as unknown as IncomingMessage);
      for (const chunk of chunks) response.emit("data", chunk);
      response.complete = complete;
      response.emit("end");
    };
    respond = sendResponse;
    const outgoing = new FakeRequest(() => {
      if (autoRespond) queueMicrotask(() => sendResponse(204));
    });
    records.push({ options, request: outgoing, response });
    return outgoing as unknown as ClientRequest;
  };
  return {
    records,
    httpsRequest,
    respond(status: number, chunks?: (Buffer | string)[], complete?: boolean) {
      if (!respond) throw new Error("request_missing");
      respond(status, chunks, complete);
    },
  };
}
function discordOptions(fake = fakeHttps()): DiscordNotificationTransportOptions {
  return {
    readWebhook: async () => WEBHOOK,
    resolveAddresses: async () => PUBLIC,
    httpsRequest: fake.httpsRequest,
  };
}
const controllers: AbortController[] = [];
function signal(): AbortSignal {
  const controller = new AbortController();
  controllers.push(controller);
  return controller.signal;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  expect(vi.mocked(lookup).mock.calls.length).toBe(0);
  expect(vi.mocked(request).mock.calls.length).toBe(0);
  vi.useRealTimers();
});

describe("fixed notification text and canonical references", () => {
  it("builds only fixed copy, a validated request reference and rebuilt conversation URL", () => {
    const input = {
      kind: "human_check",
      category: "AUTH_REQUIRED",
      requestId: REQUEST_ID,
      conversationUrl: CHAT,
      task: "untrusted task",
      error: "untrusted error",
      output: "@everyone",
    } as NotificationTextInput;
    const text = buildNotificationText(input);
    expect(text).toBe(
      `Bridge needs your attention: ChatGPT sign-in is required.\nRequest: ${REQUEST_ID}\nChat: ${CHAT}`,
    );
    expect(
      buildNotificationText({
        kind: "human_check",
        category: "CAPTCHA_OR_CHALLENGE",
        requestId: REQUEST_ID,
      }),
    ).toBe(`Bridge needs your attention: ChatGPT requires a human check.\nRequest: ${REQUEST_ID}`);
    expect(TEXT).toBe("Bridge notification test. No task content is included.");
    expect(canonicalChatReference(CHAT)).toBe(CHAT);
  });
  it.each([
    ["http", "http://chatgpt.com/c/id"],
    ["userinfo", "https://user@chatgpt.com/c/id"],
    ["password", "https://user:pass@chatgpt.com/c/id"],
    ["explicit default port", "https://chatgpt.com:443/c/id"],
    ["query", "https://chatgpt.com/c/id?"],
    ["fragment", "https://chatgpt.com/c/id#"],
    ["dot normalization", "https://chatgpt.com/a/../c/id"],
    ["encoded identifier", "https://chatgpt.com/c/%69d"],
    ["encoded delimiter", "https://chatgpt.com/c/a%2fb"],
    ["backslash", "https://chatgpt.com\\c\\id"],
    ["line break", "https://chatgpt.com/c/id\n"],
    ["trailing slash", "https://chatgpt.com/c/id/"],
    ["project path", "https://chatgpt.com/g/g-p-project/c/id"],
    ["wrong host", "https://chatgpt.com.evil.test/c/id"],
    ["oversize", `https://chatgpt.com/c/${"a".repeat(129)}`],
  ])("rejects ambiguous chat reference: %s", (_label, value) => {
    expect(canonicalChatReference(value)).toBeNull();
  });
  it("supports the exact bounded legacy request-ID grammar", () => {
    for (const requestId of ["legacy-123", "run_2026.10", "a123456z", `a${"b".repeat(62)}z`]) {
      expect(
        buildNotificationText({
          kind: "human_check",
          category: "AUTH_REQUIRED",
          requestId,
        })?.endsWith(`Request: ${requestId}`),
      ).toBe(true);
    }
    for (const requestId of [
      "short",
      ".1234567",
      "1234567.",
      "a12345z",
      `a${"b".repeat(63)}z`,
      "1234567\n",
      "@everyone",
    ]) {
      expect(
        buildNotificationText({ kind: "human_check", category: "AUTH_REQUIRED", requestId }),
      ).toBeNull();
    }
  });
  it("rejects malicious fields rather than relaying them", () => {
    expect(
      buildNotificationText({
        kind: "human_check",
        category: "AUTH_REQUIRED",
        requestId: "@everyone",
      }),
    ).toBeNull();
    expect(
      buildNotificationText({
        kind: "human_check",
        category: "AUTH_REQUIRED",
        requestId: REQUEST_ID,
        conversationUrl: "https://evil.test",
      }),
    ).toBeNull();
    expect(
      buildNotificationText({
        kind: "human_check",
        category: "unknown",
        requestId: REQUEST_ID,
      } as unknown as NotificationTextInput),
    ).toBeNull();
  });
});

describe("Discord endpoint and DNS preparation", () => {
  it.each([
    ["wrong protocol", WEBHOOK.replace("https:", "http:")],
    ["wrong host", WEBHOOK.replace("discord.com", "discordapp.com")],
    ["userinfo", WEBHOOK.replace("discord.com", "user@discord.com")],
    ["password", WEBHOOK.replace("discord.com", "user:pass@discord.com")],
    ["default port", WEBHOOK.replace("discord.com", "discord.com:443")],
    ["other port", WEBHOOK.replace("discord.com", "discord.com:8443")],
    ["query", `${WEBHOOK}?wait=true`],
    ["empty query", `${WEBHOOK}?`],
    ["fragment", `${WEBHOOK}#`],
    ["encoded separator", WEBHOOK.replace("/api/", "/api%2f")],
    ["dot normalization", WEBHOOK.replace("/api/", "/unused/../api/")],
    ["encoded token", WEBHOOK.replace(/x$/, "%78")],
    ["linebreak", `${WEBHOOK}\n`],
    ["trailing slash", `${WEBHOOK}/`],
  ])("rejects endpoint ambiguity before DNS: %s", async (_label, value) => {
    const fake = fakeHttps();
    const dns = vi.fn(async () => PUBLIC);
    const prepared = await prepareDiscordNotificationTransport(
      { ...discordOptions(fake), readWebhook: async () => value, resolveAddresses: dns },
      signal(),
    );
    expect(prepared === null).toBe(true);
    expect(dns.mock.calls.length).toBe(0);
    expect(fake.records.length).toBe(0);
  });
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
  ])("rejects nonpublic IPv4 result %s", async (address) => {
    const fake = fakeHttps();
    const prepared = await prepareDiscordNotificationTransport(
      { ...discordOptions(fake), resolveAddresses: async () => [{ address, family: 4 }] },
      signal(),
    );
    expect(prepared).toBeNull();
    expect(fake.records.length).toBe(0);
  });
  it.each([
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2001::1",
    "2001:20::1",
    "2002:7f00:1::",
    "3fff::1",
    "fe80::1%eth0",
    "64:ff9b::7f00:1",
  ])("rejects nonpublic IPv6 result %s", async (address) => {
    expect(
      await prepareDiscordNotificationTransport(
        { ...discordOptions(), resolveAddresses: async () => [{ address, family: 6 }] },
        signal(),
      ),
    ).toBeNull();
  });
  it("rejects empty, excessive, mixed public/private, malformed and mismatched DNS results", async () => {
    const cases: NotificationAddress[][] = [
      [],
      Array(17).fill(PUBLIC[0]),
      [...PUBLIC, { address: "127.0.0.1", family: 4 }],
      [{ address: "not-an-address", family: 4 }],
      [{ address: "127.0.0.1", family: 6 }],
    ];
    for (const addresses of cases) {
      expect(
        await prepareDiscordNotificationTransport(
          { ...discordOptions(), resolveAddresses: async () => addresses },
          signal(),
        ),
      ).toBeNull();
    }
  });
  it.each([
    { address: "162.159.128.233", family: 4 as const },
    { address: "2606:4700::6810:1234", family: 6 as const },
    { address: "2001:4860:4860::8888", family: 6 as const },
  ])("pins approved address into the real request lookup ($family)", async (address) => {
    const fake = fakeHttps();
    const addresses = [{ ...address }];
    const dns = vi.fn(async () => addresses);
    const parentSignal = signal();
    const prepared = await prepareDiscordNotificationTransport(
      { ...discordOptions(fake), resolveAddresses: dns },
      parentSignal,
    );
    // Mutating the source after validation must not change the connection destination.
    addresses[0] = { address: "127.0.0.1", family: 4 };
    expect(await prepared?.send(TEXT, parentSignal)).toBe("delivered");
    const options = fake.records[0]?.options;
    if (!options) throw new Error("request_missing");
    expect(options?.hostname).toBe("discord.com");
    expect(options?.servername).toBe("discord.com");
    expect(options?.rejectUnauthorized).toBe(true);
    expect(options?.checkServerIdentity).toBe(checkServerIdentity);
    expect(options?.port).toBe(443);
    expect(options?.family).toBe(address.family);
    expect(options?.method).toBe("POST");
    expect(options?.maxHeaderSize).toBe(8192);
    expect((options.agent as Agent).options.proxyEnv).toEqual({});
    expect((options.agent as Agent).options.keepAlive).toBe(false);
    expect((options.agent as Agent).options.maxCachedSessions).toBe(0);
    const single = vi.fn();
    options?.lookup?.("discord.com", {}, single);
    expect(single).toHaveBeenCalledWith(null, address.address, address.family);
    const all = vi.fn();
    options?.lookup?.("discord.com", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [address]);
    const denied = vi.fn();
    options?.lookup?.("elsewhere.test", {}, denied);
    expect(denied.mock.calls[0]?.[0] instanceof Error).toBe(true);
    expect(dns.mock.calls.length).toBe(1);
    const payload = JSON.parse(fake.records[0]?.request.body ?? "{}");
    expect(payload).toEqual({
      content: TEXT,
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    });
    expect(fake.records[0]?.request.destroyed).toBe(true);
    expect(fake.records[0]?.response.destroyed).toBe(true);
    expect(Object.keys(prepared ?? {})).toEqual(["deadlineAt", "send"]);
  });
});

describe("bounded one-shot Discord effects", () => {
  it.each([
    [200, "delivered"],
    [204, "delivered"],
    [429, "not_sent_retryable"],
    [400, "not_sent"],
    [401, "not_sent"],
    [403, "not_sent"],
    [404, "not_sent"],
    [405, "not_sent"],
    [413, "not_sent"],
    [301, "uncertain"],
    [302, "uncertain"],
    [307, "uncertain"],
    [308, "uncertain"],
    [408, "uncertain"],
    [500, "uncertain"],
    [503, "uncertain"],
  ])("classifies complete HTTP %i without redirect or retry", async (status, outcome) => {
    const fake = fakeHttps(false);
    const abort = signal();
    const prepared = await prepareDiscordNotificationTransport(discordOptions(fake), abort);
    const result = prepared?.send(TEXT, abort);
    fake.respond(status as number);
    expect(await result).toBe(outcome);
    expect(fake.records.length).toBe(1);
    expect(await prepared?.send(TEXT, abort)).toBe("not_sent");
    expect(fake.records.length).toBe(1);
  });
  it("does not regard partial or oversized successful/retry responses as authoritative", async () => {
    for (const status of [204, 429]) {
      for (const complete of [true, false]) {
        const fake = fakeHttps(false);
        const abort = signal();
        const prepared = await prepareDiscordNotificationTransport(
          { ...discordOptions(fake), maxResponseBytes: 4 },
          abort,
        );
        const result = prepared?.send(TEXT, abort);
        fake.respond(status, complete ? [Buffer.alloc(5)] : [], complete);
        expect(await result).toBe("uncertain");
        expect(fake.records.length).toBe(1);
      }
    }
  });
  it("bounds cumulative response bytes including multibyte strings", async () => {
    const fake = fakeHttps(false);
    const abort = signal();
    const prepared = await prepareDiscordNotificationTransport(
      { ...discordOptions(fake), maxResponseBytes: 4 },
      abort,
    );
    const result = prepared?.send(TEXT, abort);
    fake.respond(204, ["é", "é", "é"]);
    expect(await result).toBe("uncertain");
  });
  it("returns uncertain on thrown/error/aborted effects without provider diagnostic text", async () => {
    const abort = signal();
    const prepared = await prepareDiscordNotificationTransport(
      {
        ...discordOptions(),
        httpsRequest: () => {
          throw new Error(WEBHOOK);
        },
      },
      abort,
    );
    expect(await prepared?.send(TEXT, abort)).toBe("uncertain");
    const fake = fakeHttps(false);
    const next = await prepareDiscordNotificationTransport(discordOptions(fake), abort);
    const result = next?.send(TEXT, abort);
    fake.records[0]?.request.emit("error", new Error(WEBHOOK));
    expect(await result).toBe("uncertain");
    fake.records[0]?.request.emit("error", new Error(WEBHOOK));
  });
  it("captures the host HTTPS implementation when preparing the binding", async () => {
    const fake = fakeHttps();
    const options = discordOptions(fake);
    const abort = signal();
    const prepared = await prepareDiscordNotificationTransport(options, abort);
    const changed = vi.fn(() => {
      throw new Error("binding_changed");
    });
    options.httpsRequest = changed;
    expect(await prepared?.send(TEXT, abort)).toBe("delivered");
    expect(changed.mock.calls.length).toBe(0);
    expect(fake.records.length).toBe(1);
  });
  it("cancels before writing when abort occurs while constructing a request", async () => {
    const fake = fakeHttps(false);
    const controller = new AbortController();
    const prepared = await prepareDiscordNotificationTransport(
      {
        ...discordOptions(fake),
        httpsRequest: (options, callback) => {
          const outgoing = fake.httpsRequest(options, callback);
          controller.abort();
          return outgoing;
        },
      },
      controller.signal,
    );
    expect(await prepared?.send(TEXT, controller.signal)).toBe("uncertain");
    expect(fake.records[0]?.request.body === undefined).toBe(true);
    expect(fake.records[0]?.request.destroyed).toBe(true);
  });
  it("rejects non-builder text before any effect", async () => {
    for (const text of [
      "task content",
      "@everyone",
      `${TEXT}\nsecret`,
      `${TEXT}\r\n`,
      `Bridge needs your attention: ChatGPT sign-in is required.\nRequest: ${REQUEST_ID}\nChat: ${CHAT}\nextra`,
    ]) {
      const fake = fakeHttps();
      const abort = signal();
      const prepared = await prepareDiscordNotificationTransport(discordOptions(fake), abort);
      expect(await prepared?.send(text, abort)).toBe("not_sent");
      expect(fake.records.length).toBe(0);
    }
  });
  it("cancelled preparation never invokes a late secret or DNS result", async () => {
    for (const phase of ["secret", "dns"]) {
      const controller = new AbortController();
      const secret = deferred<string | null>();
      const dns = deferred<NotificationAddress[]>();
      const fake = fakeHttps();
      const pending = prepareDiscordNotificationTransport(
        {
          ...discordOptions(fake),
          readWebhook: () => (phase === "secret" ? secret.promise : Promise.resolve(WEBHOOK)),
          resolveAddresses: () => dns.promise,
        },
        controller.signal,
      );
      await Promise.resolve();
      await Promise.resolve();
      controller.abort();
      expect(await pending).toBeNull();
      secret.resolve(WEBHOOK);
      dns.resolve(PUBLIC);
      await Promise.resolve();
      await Promise.resolve();
      expect(fake.records.length).toBe(0);
    }
  });
  it("pre-aborted and expired prepared sends are known not sent", async () => {
    vi.useFakeTimers();
    const fake = fakeHttps();
    const abort = signal();
    const prepared = await prepareDiscordNotificationTransport(
      { ...discordOptions(fake), totalTimeoutMs: 10 },
      abort,
    );
    expect(prepared?.deadlineAt).toBe(Date.now() + 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(await prepared?.send(TEXT, abort)).toBe("not_sent");
    expect(fake.records.length).toBe(0);
    const controller = new AbortController();
    controller.abort();
    const secret = vi.fn(async () => WEBHOOK);
    expect(
      await prepareDiscordNotificationTransport(
        { ...discordOptions(), readWebhook: secret },
        controller.signal,
      ),
    ).toBeNull();
    expect(secret.mock.calls.length).toBe(0);
  });
  it("shares one total deadline across secret, DNS and stalled HTTPS/TLS", async () => {
    vi.useFakeTimers();
    const secret = deferred<string | null>();
    const dns = deferred<NotificationAddress[]>();
    const fake = fakeHttps(false);
    const abort = signal();
    const pending = prepareDiscordNotificationTransport(
      {
        ...discordOptions(fake),
        totalTimeoutMs: 100,
        readWebhook: () => secret.promise,
        resolveAddresses: () => dns.promise,
      },
      abort,
    );
    await vi.advanceTimersByTimeAsync(30);
    secret.resolve(WEBHOOK);
    await vi.advanceTimersByTimeAsync(30);
    dns.resolve(PUBLIC);
    const prepared = await pending;
    const result = prepared?.send(TEXT, abort);
    await vi.advanceTimersByTimeAsync(39);
    expect(fake.records[0]?.request.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("uncertain");
    expect(fake.records[0]?.request.destroyed).toBe(true);
    fake.respond(204);
    expect(await result).toBe("uncertain");
    expect(fake.records.length).toBe(1);
  });
  it("bounds hung secret and DNS reads and fences their late completion", async () => {
    vi.useFakeTimers();
    for (const phase of ["secret", "dns"]) {
      const late = deferred<never>();
      const fake = fakeHttps();
      const pending = prepareDiscordNotificationTransport(
        {
          ...discordOptions(fake),
          totalTimeoutMs: 10,
          readWebhook: () => (phase === "secret" ? late.promise : Promise.resolve(WEBHOOK)),
          resolveAddresses: () => late.promise,
        },
        signal(),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toBeNull();
      late.reject(new Error(WEBHOOK));
      await Promise.resolve();
      expect(fake.records.length).toBe(0);
    }
  });
  it("cancels an in-flight effect and keeps late success uncertain", async () => {
    const fake = fakeHttps(false);
    const controller = new AbortController();
    const prepared = await prepareDiscordNotificationTransport(
      discordOptions(fake),
      controller.signal,
    );
    const result = prepared?.send(TEXT, controller.signal);
    controller.abort();
    expect(await result).toBe("uncertain");
    expect(fake.records[0]?.request.destroyed).toBe(true);
    fake.respond(204);
    expect(await result).toBe("uncertain");
  });
  it("validates timeout and response bounds without reading a secret", async () => {
    for (const value of [0, -1, Infinity, 1.5, 30_001]) {
      const secret = vi.fn(async () => WEBHOOK);
      expect(
        await prepareDiscordNotificationTransport(
          { ...discordOptions(), readWebhook: secret, totalTimeoutMs: value },
          signal(),
        ),
      ).toBeNull();
      expect(secret.mock.calls.length).toBe(0);
    }
    for (const value of [0, -1, Infinity, 1.5, 65_537]) {
      const secret = vi.fn(async () => WEBHOOK);
      expect(
        await prepareDiscordNotificationTransport(
          { ...discordOptions(), readWebhook: secret, maxResponseBytes: value },
          signal(),
        ),
      ).toBeNull();
      expect(secret.mock.calls.length).toBe(0);
    }
  });
});

describe("host-bound approved email sender", () => {
  it.each<NotificationSendOutcome>(["delivered", "not_sent", "not_sent_retryable", "uncertain"])(
    "preserves explicit %s without adding a retry",
    async (outcome) => {
      const send = vi.fn(async () => outcome);
      const abort = signal();
      const prepared = await prepareEmailNotificationTransport(
        { resolveSender: async () => ({ send }) },
        abort,
      );
      expect(send.mock.calls.length).toBe(0);
      expect(await prepared?.send(TEXT, abort)).toBe(outcome);
      expect(await prepared?.send(TEXT, abort)).toBe("not_sent");
      expect(send.mock.calls.length).toBe(1);
      expect((send.mock.calls[0] as unknown[]).length).toBe(2);
    },
  );
  it("does not expose resolver errors, recipients or sender details", async () => {
    expect(
      await prepareEmailNotificationTransport(
        {
          resolveSender: async () => {
            throw new Error("private-provider-data");
          },
        },
        signal(),
      ),
    ).toBeNull();
    expect(
      await prepareEmailNotificationTransport({ resolveSender: async () => null }, signal()),
    ).toBeNull();
    const abort = signal();
    const prepared = await prepareEmailNotificationTransport(
      {
        resolveSender: async () => ({
          send: async () => {
            throw new Error("private-provider-data");
          },
        }),
      },
      abort,
    );
    expect(Object.keys(prepared ?? {})).toEqual(["deadlineAt", "send"]);
    expect(await prepared?.send(TEXT, abort)).toBe("uncertain");
  });
  it("captures the approved bound sender and suppresses exceptional property access", async () => {
    const original = vi.fn(async () => "delivered" as NotificationSendOutcome);
    const changed = vi.fn(async () => "uncertain" as NotificationSendOutcome);
    const sender = { send: original };
    const abort = signal();
    const prepared = await prepareEmailNotificationTransport(
      { resolveSender: async () => sender },
      abort,
    );
    sender.send = changed;
    expect(await prepared?.send(TEXT, abort)).toBe("delivered");
    expect(original.mock.calls.length).toBe(1);
    expect(changed.mock.calls.length).toBe(0);
    expect(
      await prepareEmailNotificationTransport(
        {
          resolveSender: async () => ({
            get send() {
              throw new Error("private-provider-data");
            },
          }),
        },
        abort,
      ),
    ).toBeNull();
  });
  it("treats unknown provider outcomes as uncertain", async () => {
    const abort = signal();
    const prepared = await prepareEmailNotificationTransport(
      {
        resolveSender: async () => ({
          send: async () => "private-provider-data" as NotificationSendOutcome,
        }),
      },
      abort,
    );
    expect(await prepared?.send(TEXT, abort)).toBe("uncertain");
  });
  it("bounds resolving credentials and does not call a late bound sender", async () => {
    vi.useFakeTimers();
    const late = deferred<{ send: () => Promise<NotificationSendOutcome> }>();
    const send = vi.fn(async () => "delivered" as const);
    const result = prepareEmailNotificationTransport(
      { totalTimeoutMs: 10, resolveSender: () => late.promise },
      signal(),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBeNull();
    late.resolve({ send });
    await Promise.resolve();
    expect(send.mock.calls.length).toBe(0);
  });
  it("bounds an uncancellable underlying sender and fences late delivery", async () => {
    vi.useFakeTimers();
    const late = deferred<NotificationSendOutcome>();
    let sendSignal: AbortSignal | undefined;
    const abort = signal();
    const prepared = await prepareEmailNotificationTransport(
      {
        totalTimeoutMs: 10,
        resolveSender: async () => ({
          send: (_text, signal) => {
            sendSignal = signal;
            return late.promise;
          },
        }),
      },
      abort,
    );
    const result = prepared?.send(TEXT, abort);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBe("uncertain");
    expect(sendSignal?.aborted).toBe(true);
    late.resolve("delivered");
    await Promise.resolve();
    expect(await result).toBe("uncertain");
  });
  it("does not pass arbitrary text, a recipient or a host to a bound sender", async () => {
    const send = vi.fn(async () => "delivered" as const);
    const abort = signal();
    const prepared = await prepareEmailNotificationTransport(
      { resolveSender: async () => ({ send }) },
      abort,
    );
    expect(await prepared?.send("untrusted task content", abort)).toBe("not_sent");
    expect(send.mock.calls.length).toBe(0);
  });
});
