import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoctorItem } from "../../src/diagnostics/doctor.js";

const runDoctor = vi.hoisted(() => vi.fn());

vi.mock("../../src/diagnostics/doctor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/diagnostics/doctor.js")>();
  return { ...actual, runDoctor };
});

import { main } from "../../src/cli/main.js";

const items: DoctorItem[] = [
  { name: "node", ok: true, detail: "v22.13.0" },
  { name: "login", ok: false, detail: "AUTH_REQUIRED" },
];

describe("doctor CLI output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runDoctor.mockReset();
  });

  it("writes one JSON line with the unmodified doctor item shape for --json", async () => {
    runDoctor.mockResolvedValue(items);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      expect(await main(["doctor", "--json"])).toBe(1);
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0])).toEqual({ ok: false, items });
    } finally {
      stdout.mockRestore();
    }
  });

  it("keeps the existing human-readable doctor format without --json", async () => {
    runDoctor.mockResolvedValue(items);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      expect(await main(["doctor"])).toBe(1);
      expect(writes.join("")).toBe(
        "OK   node               v22.13.0\nNG   login              AUTH_REQUIRED\n",
      );
    } finally {
      stdout.mockRestore();
    }
  });
});
