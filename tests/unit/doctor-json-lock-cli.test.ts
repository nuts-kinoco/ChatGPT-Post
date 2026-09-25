import { afterEach, describe, expect, it, vi } from "vitest";

const runDoctor = vi.hoisted(() => vi.fn());

vi.mock("../../src/diagnostics/doctor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/diagnostics/doctor.js")>();
  return { ...actual, runDoctor };
});

import { main } from "../../src/cli/main.js";

describe("doctor --json structured lock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runDoctor.mockReset();
  });

  it("preserves the structured held lock payload in CLI JSON", async () => {
    const lock = {
      pid: 42,
      requestId: "request-held",
      command: "run",
      heldSinceMs: 1_700_000_000_000,
      heartbeatAgeMs: 5_000,
      stale: false,
      reclaimable: false,
    };
    const items = [{ name: "lock", ok: false, detail: "held", lock }];
    runDoctor.mockResolvedValue(items);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      expect(await main(["doctor", "--json", "--no-login"])).toBe(1);
      expect(JSON.parse(writes[0] ?? "")).toEqual({ ok: false, items });
    } finally {
      stdout.mockRestore();
    }
  });
});
