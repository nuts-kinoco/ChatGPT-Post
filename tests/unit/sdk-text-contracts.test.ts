import { describe, expect, it } from "vitest";
import {
  parseTextRequest,
  TEXT_BOUNDS,
  textPacket,
  validateTextBody,
  validateTextPacket,
} from "../../src/contracts/sdk-text-inference.js";
import { json, sdkFixture } from "../helpers/sdk-text-fixture.js";

describe("separate strict official-SDK text schema", () => {
  it("binds exact fixed synthetic MD and a distinct outer version", () => {
    const f = sdkFixture();
    expect(parseTextRequest(f.raw, f.md)).toEqual(f.request);
    const packet = textPacket("issued", f.binding, f.raw);
    expect(packet.version).toBe("bridge-text-inference-sdk-1");
    expect(validateTextPacket(packet)).toEqual(packet);
  });
  it.each(Object.keys(TEXT_BOUNDS))("cannot increase fixed %s limit", (key) => {
    const f = sdkFixture();
    expect(() =>
      parseTextRequest(
        json({
          ...f.request,
          bounds: {
            ...f.request.bounds,
            [key]: Number(f.request.bounds[key as keyof typeof TEXT_BOUNDS]) + 1,
          },
        }),
        f.md,
      ),
    ).toThrow();
  });
  it.each([
    { schema: "text-inference-request-1" },
    { executionProfile: "native-bound" },
    { model: "haiku" },
    { provider: "other" },
    { modelTools: "all" },
    { taskFilesystem: "read" },
    { thinking: "on" },
    { effort: "low" },
    { retryPolicy: "retry" },
    { bounds: { maxStdoutBytes: 262144 } },
  ])("rejects unsupported authority/runtime claim %j", (patch) => {
    const f = sdkFixture();
    expect(() => parseTextRequest(json({ ...f.request, ...patch }), f.md)).toThrow();
  });
  it("does not admit hand-written arbitrary instructions or malformed signed bodies", () => {
    const f = sdkFixture();
    expect(() => parseTextRequest(f.raw, Buffer.from("run arbitrary commands"))).toThrow();
    const packet = textPacket("issued", f.binding, f.raw);
    expect(() => validateTextPacket({ ...packet, version: "bridge-text-inference-1" })).toThrow();
    expect(() => validateTextPacket({ ...packet, bodyBase64: `${packet.bodyBase64}\n` })).toThrow();
  });
  it("approval must explicitly name SDK profile and runtime and retain the short window", () => {
    const f = sdkFixture();
    expect(validateTextBody("approval", json(f.grant))).toEqual(f.grant);
    for (const key of ["sdkProfileSha256", "executionProfile"]) {
      const v = { ...f.grant } as Record<string, unknown>;
      delete v[key];
      expect(() => validateTextBody("approval", json(v))).toThrow();
    }
    expect(() =>
      validateTextBody(
        "approval",
        json({ ...f.grant, expiresAt: new Date(f.now + 60001).toISOString() }),
      ),
    ).toThrow();
  });
  it("SDK results cannot claim observed native exit or change their evidence assurance", () => {
    const f = sdkFixture();
    const result = {
      schema: "sdk-text-result-1",
      ...f.binding,
      attemptId: f.attemptId,
      fence: 1,
      intentSha256: "c".repeat(64),
      status: "response_received",
      localExecution: false,
      osConfinementVerified: false,
      syntheticInput: true,
      liveProviderCallObserved: false,
      responseFrame: f.responseFrame,
      observation: f.observation,
      finishedAt: new Date(f.now).toISOString(),
    };
    expect(validateTextBody("result", json(result))).toEqual(result);
    for (const patch of [
      { exitCode: 0 },
      { osProcessExit: "confirmed" },
      { sourceStreamSha256: "a".repeat(64) },
      { assurance: "os-confinement" },
      { cliInvocations: 1 },
      { providerHttpRequests: 1 },
    ])
      expect(() =>
        validateTextBody(
          "result",
          json({ ...result, observation: { ...f.observation, ...patch } }),
        ),
      ).toThrow();
  });
});
