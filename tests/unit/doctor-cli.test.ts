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

  it("passes no login probe for --no-login and omits the login item", async () => {
    const passiveItems = [{ name: "node", ok: true, detail: "v22.13.0" }] satisfies DoctorItem[];
    const probe = vi.fn().mockResolvedValue({ ok: true, detail: "logged in" });
    runDoctor.mockImplementation(async ({ loginProbe }: { loginProbe: typeof probe | null }) => {
      if (loginProbe) await loginProbe();
      return passiveItems;
    });
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      expect(await main(["doctor", "--json", "--no-login"])).toBe(0);
      expect(probe).not.toHaveBeenCalled();
      expect(JSON.parse(writes[0] ?? "")).toEqual({ ok: true, items: passiveItems });
    } finally {
      stdout.mockRestore();
    }
  });

  it("keeps the login probe for doctor without --no-login", async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true, detail: "logged in" });
    runDoctor.mockImplementation(async ({ loginProbe }: { loginProbe: typeof probe | null }) => {
      if (loginProbe) await probe();
      return items;
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await main(["doctor", "--json"]);

      expect(probe).toHaveBeenCalledOnce();
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
