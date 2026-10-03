import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startUiServer } from "../../src/ui/server.js";

it("independent shutdown rejects a mutation body accepted before shutdown but completed after it", async () => {
  const state = await mkdtemp(join(tmpdir(), "review-ui-http-shutdown-"));
  const server = await startUiServer({ stateDir: state, profile: "production" });
  try {
    let accepted!: () => void;
    const seen = new Promise<void>((r) => {
      accepted = r;
    });
    server.server.once("request", () => accepted());
    const payload = JSON.stringify({
      taskSpecHash: "a".repeat(64),
      taskFileHash: "b".repeat(64),
      sequence: 1,
    });
    let finish!: () => void;
    const response = new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const req = request(
          `${server.origin}/api/tasks/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/start`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${server.token}`,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            },
          },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode, body }));
          },
        );
        req.on("error", reject);
        req.write(payload.slice(0, 10));
        finish = () => req.end(payload.slice(10));
      },
    );
    await seen;
    const closed = server.close();
    finish();
    const result = await response;
    expect(result.status).toBe(409);
    expect(result.body).toContain("runtime_shutting_down");
    await closed;
  } finally {
    await server.close();
    await rm(state, { recursive: true, force: true });
  }
});
