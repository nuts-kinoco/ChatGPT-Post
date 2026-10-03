import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UiTaskResponse } from "../../src/contracts/ui.js";
import { demoTask } from "../../src/ui/demo.js";
import { MAX_UI_BODY_BYTES, startUiServer, type UiServerHandle } from "../../src/ui/server.js";

function bound(view: UiTaskResponse) {
  return {
    taskSpecHash: view.task.result.task_spec_hash,
    taskFileHash: view.task.result.task_file_hash,
    sequence: view.task.result.observation_seq,
  };
}
describe("loopback UI HTTP security and product routes", () => {
  let directory: string;
  let publicDir: string;
  const servers: UiServerHandle[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bridge-ui-http-"));
    publicDir = join(directory, "public");
    await mkdir(publicDir);
    await writeFile(
      join(publicDir, "index.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><script src="/app.js" defer></script></body></html>',
    );
    await writeFile(join(publicDir, "app.js"), '"use strict";');
    await writeFile(join(publicDir, "styles.css"), "body { color: black; }");
    await writeFile(join(directory, "secret.txt"), "not-a-public-asset");
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function open(profile: "production" | "demo" = "demo") {
    const server = await startUiServer({ profile, stateDir: directory, publicDir });
    servers.push(server);
    return server;
  }
  function api(server: UiServerHandle, path: string, method = "GET", value?: unknown) {
    return fetch(`${server.origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${server.token}`,
        ...(value === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  }
  async function task(response: Response): Promise<UiTaskResponse> {
    expect(response.status).toBeLessThan(300);
    return (await response.json()) as UiTaskResponse;
  }
  it("binds only 127.0.0.1 and puts a fresh capability only in the launch fragment", async () => {
    const first = await open();
    const second = await open("production");
    expect(first.server.address()).toMatchObject({ address: "127.0.0.1" });
    expect(new URL(first.url).search).toBe("");
    expect(new URL(first.url).hash).toBe(`#token=${first.token}`);
    expect(first.token).not.toBe(second.token);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await (await api(first, "/api/bootstrap")).text()).not.toContain(first.token);
    expect((await fetch(`${first.origin}/`)).headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
  });
  it("requires authorization on all API reads and mutations and never sends CORS headers", async () => {
    const server = await open();
    for (const path of ["/api/bootstrap", "/api/tasks", "/api/diagnostics", "/api/no-such-route"]) {
      const response = await fetch(`${server.origin}${path}`);
      expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await response.json()).toEqual({
        error: {
          code: "authentication_required",
          message: "A per-launch local capability token is required",
          retryable: false,
          reexecute: false,
        },
      });
    }
    expect(
      (
        await fetch(`${server.origin}/api/demo/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${server.origin}/api/bootstrap`, {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    expect((await api(server, "/api/bootstrap")).status).toBe(200);
  });
  it("rejects DNS rebinding, foreign/null origins, cross-site requests and CORS preflight", async () => {
    const server = await open();
    for (const header of [
      { Host: "evil.example" },
      { Host: `localhost:${new URL(server.origin).port}` },
      { Origin: "https://evil.example" },
      { Origin: "null" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
    ]) {
      const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const call = request(
          `${server.origin}/api/bootstrap`,
          { headers: { Authorization: `Bearer ${server.token}`, ...header } },
          (reply) => {
            let text = "";
            reply.setEncoding("utf8");
            reply.on("data", (chunk: string) => {
              text += chunk;
            });
            reply.on("end", () => resolve({ status: reply.statusCode ?? 0, text }));
          },
        );
        call.on("error", reject);
        call.end();
      });
      expect({ header, status: response.status }).toEqual({ header, status: 403 });
      expect(response.text).not.toContain(server.token);
    }
    expect(
      (
        await fetch(`${server.origin}/api/bootstrap`, {
          method: "OPTIONS",
          headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${server.origin}/api/bootstrap`, {
          headers: {
            Authorization: `Bearer ${server.token}`,
            Origin: server.origin,
            "Sec-Fetch-Site": "same-origin",
          },
        })
      ).status,
    ).toBe(200);
  });
  it("serves only exact public assets with hardened headers and no filesystem path route", async () => {
    const server = await open();
    for (const path of ["/", "/index.html", "/app.js", "/styles.css"]) {
      const response = await fetch(`${server.origin}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).not.toContain("unsafe-inline");
      expect(await response.text()).not.toContain(server.token);
    }
    for (const path of [
      "/secret.txt",
      "/src/ui/service.ts",
      "/%2e%2e/secret.txt",
      "/app.js?token=leak",
      "/__proto__",
      "/package.json",
    ]) {
      const response = await fetch(`${server.origin}${path}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("not-a-public-asset");
    }
  });
  it("allows only the explicit static dock/detail navigation parameters", async () => {
    const server = await open();
    for (const path of [
      "/?view=dock",
      "/?view=detail&tab=approval",
      "/?view=detail&tab=evidence&task=12345678-1234-1234-1234-123456789abc",
    ])
      expect((await fetch(`${server.origin}${path}`)).status).toBe(200);
    for (const path of [
      "/?view=dock&view=detail",
      "/?view=detail&token=secret",
      "/?view=other",
      "/?view=detail&tab=unknown",
      "/?view=detail&task=../secret",
      "/?view=detail&unknown=yes",
      "/api/bootstrap?view=dock",
    ])
      expect(
        (
          await fetch(`${server.origin}${path}`, {
            headers: { Authorization: `Bearer ${server.token}` },
          })
        ).status,
      ).toBe(404);
  });
  it("rejects duplicate JSON keys, invalid UTF-8, unexpected fields, content types and oversized bodies", async () => {
    const server = await open();
    for (const body of [
      '{"title":"one","title":"two"}',
      '{"title":"\\ud800"}',
      "{not json}",
      Buffer.from([0xff]),
    ]) {
      const response = await fetch(`${server.origin}/api/demo/tasks`, {
        method: "POST",
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_json");
    }
    expect(
      (
        await api(server, "/api/demo/tasks", "POST", {
          title: "fine",
          command: "calc.exe",
          path: "/tmp",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${server.origin}/api/demo/tasks`, {
          method: "POST",
          headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    const oversized = await fetch(`${server.origin}/api/demo/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: " ".repeat(MAX_UI_BODY_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error.reexecute).toBe(false);
  });
  it("rejects trailing line breaks in hash-bound request fields at the request schema", async () => {
    const server = await open();
    const view = await task(await api(server, "/api/demo/tasks", "POST", {}));
    for (const field of ["taskSpecHash", "taskFileHash"] as const) {
      const input = { ...bound(view), [field]: `${bound(view)[field]}\n` };
      const response = await api(
        server,
        `/api/tasks/${view.task.summary.requestId}/approve`,
        "POST",
        input,
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_request");
    }
    const response = await api(server, `/api/tasks/${view.task.summary.requestId}/ack`, "POST", {
      eventId: "12345678-1234-1234-1234-123456789abc",
      sequence: 1,
      payloadSha256: `${"0".repeat(64)}\n`,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });
  it("runs the demo product lifecycle over HTTP and retrieves immutable result, events and receipts", async () => {
    const server = await open();
    let view = await task(
      await api(server, "/api/demo/tasks", "POST", { title: "HTTP synthetic task" }),
    );
    const id = view.task.summary.requestId;
    const path = `/api/tasks/${id}`;
    const detail = await task(await api(server, path));
    expect(detail.task.rawSpec).toBe(view.task.rawSpec);
    expect((await api(server, `${path}/approve`, "POST", {})).status).toBe(400);
    view = await task(await api(server, `${path}/approve`, "POST", bound(view)));
    view = await task(await api(server, `${path}/start`, "POST", bound(view)));
    expect(view.task.result.status).toBe("running");
    view = await task(
      await api(server, `${path}/demo-observation`, "POST", { outcome: "succeeded" }),
    );
    expect(view.task.result.status).toBe("succeeded");
    expect(view.profile).toBe("demo");
    const terminal = view.task.handshakes.terminal_result;
    expect(terminal).not.toBeNull();
    if (!terminal) throw new Error("missing terminal");
    view = await task(
      await api(server, `${path}/ack`, "POST", {
        eventId: terminal.eventId,
        payloadSha256: terminal.payloadSha256,
        sequence: terminal.sequence,
      }),
    );
    expect(view.task.delivery.acknowledged).toBe(true);
    expect((await (await api(server, `${path}/events`)).json()).events).toHaveLength(6);
    expect(
      (await (await api(server, `${path}/receipts`)).json()).handshakes.result_ack.eventId,
    ).toBe(terminal.eventId);
    expect((await (await api(server, `${path}/result`)).json()).result).toEqual(view.task.result);
    expect(
      (await (await api(server, `${path}/preflight`)).json()).preflight.executionAuthorized,
    ).toBe(false);
  });
  it("rejects production execution and demo controls after a valid local import", async () => {
    const server = await open("production");
    const input = demoTask({});
    expect((await (await api(server, "/api/validate", "POST", input)).json()).valid).toBe(true);
    const view = await task(await api(server, "/api/tasks", "POST", input));
    const path = `/api/tasks/${view.task.summary.requestId}`;
    expect((await api(server, `${path}/approve`, "POST", bound(view))).status).toBe(409);
    expect((await api(server, `${path}/start`, "POST", bound(view))).status).toBe(409);
    expect((await api(server, `${path}/cancel`, "POST", {})).status).toBe(409);
    expect((await api(server, "/api/demo/tasks", "POST", {})).status).toBe(403);
    expect(
      (await api(server, `${path}/demo-observation`, "POST", { outcome: "succeeded" })).status,
    ).toBe(403);
    expect((await api(server, `${path}/result`)).status).toBe(409);
    expect((await task(await api(server, path))).task.result.status).toBe("awaiting_approval");
  });
  it("rejects duplicate authorization headers rather than choosing an ambiguous credential", async () => {
    const server = await open();
    const status = await new Promise<number>((resolve, reject) => {
      const requestObject = request(
        `${server.origin}/api/bootstrap`,
        {
          headers: [
            "Host",
            new URL(server.origin).host,
            "Authorization",
            `Bearer ${server.token}`,
            "Authorization",
            `Bearer ${server.token}`,
          ],
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      requestObject.on("error", reject);
      requestObject.end();
    });
    expect(status).toBe(401);
  });
});
