import type { Locator, Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { MAX_DOM_CANDIDATES, scanVisible } from "../../src/chatgpt/dom-observation.js";
import { DomUnexpected, probe, resolve } from "../../src/chatgpt/selectors.js";

function collection(visible: Array<boolean | Error>) {
  const items = visible.map((value, index) => ({
    index,
    isVisible: vi.fn(async () => {
      if (value instanceof Error) throw value;
      return value;
    }),
    isEnabled: vi.fn(async () => true),
  }));
  return { count: vi.fn(async () => items.length), nth: (i: number) => items[i], items };
}
function rootWith(...candidates: ReturnType<typeof collection>[]) {
  let calls = 0;
  const next = vi.fn(() => candidates[Math.min(calls++, candidates.length - 1)]);
  return { locator: next, getByRole: next, getByTestId: next, next };
}
const opts = { verifiedOnly: true };

describe("bounded complete selector observation", () => {
  it.each([0, 1, 20, 21, MAX_DOM_CANDIDATES])("fully scans %i attached matches", async (count) => {
    const loc = collection(Array.from({ length: count }, (_, i) => i === count - 1));
    const result = await scanVisible(loc as unknown as Locator);
    expect(result).toMatchObject({
      kind: count === 0 ? "absent" : "unique",
      attached: count,
      scanned: count,
      visible: count === 0 ? 0 : 1,
      complete: true,
    });
    if (result.kind === "unique") expect(result.locator).toBe(loc.items[count - 1]);
  });
  it("a visible 21st duplicate is ambiguous, never unique", async () => {
    const root = rootWith(collection(Array.from({ length: 21 }, (_, i) => i === 0 || i === 20)));
    await expect(resolve(root as unknown as Page, "composer", opts)).rejects.toBeInstanceOf(
      DomUnexpected,
    );
    expect(await probe(root as unknown as Page, "composer", opts)).toMatchObject({
      found: false,
      matches: 2,
      complete: true,
      reason: "ambiguous",
    });
  });
  it("does not erase earlier ambiguity with a broader unique fallback", async () => {
    for (const action of [resolve, probe]) {
      const root = rootWith(collection([true, true]), collection([true]));
      if (action === resolve)
        await expect(action(root as unknown as Page, "composer", opts)).rejects.toBeInstanceOf(
          DomUnexpected,
        );
      else
        expect(await action(root as unknown as Page, "composer", opts)).toMatchObject({
          found: false,
          reason: "ambiguous",
        });
      expect(root.next).toHaveBeenCalledTimes(1);
    }
  });
  it.each([[[]], [[false, false]]])(
    "complete absence permits the verified fallback (%j)",
    async (flags) => {
      const second = collection([false, true]);
      const root = rootWith(collection(flags), second);
      expect(await resolve(root as unknown as Page, "composer", opts)).toBe(second.items[1]);
      expect(root.next).toHaveBeenCalledTimes(2);
    },
  );
  it("over-cap population is incomplete without probing a partial population", async () => {
    const first = collection(Array.from({ length: MAX_DOM_CANDIDATES + 1 }, (_, i) => i === 0));
    const root = rootWith(first, collection([true]));
    await expect(resolve(root as unknown as Page, "composer", opts)).rejects.toBeInstanceOf(
      DomUnexpected,
    );
    expect(root.next).toHaveBeenCalledTimes(1);
    expect(first.items[0]?.isVisible).not.toHaveBeenCalled();
    expect(await scanVisible(first as unknown as Locator)).toMatchObject({
      kind: "incomplete",
      reason: "candidate_limit",
      scanned: 0,
      complete: false,
    });
  });
  it("visibility failure is incomplete and never includes exception/page text", async () => {
    const sensitive = "PROMPT_AND_PRIVATE_PAGE_TEXT";
    const root = rootWith(collection([true, new Error(sensitive)]), collection([true]));
    let error: unknown;
    try {
      await resolve(root as unknown as Page, "composer", opts);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DomUnexpected);
    const tried = (error as DomUnexpected).tried.join(" ");
    expect(tried).toContain("visibility_unreadable");
    expect(tried).toContain("scanned=1");
    expect(tried).not.toContain(sensitive);
    expect(root.next).toHaveBeenCalledTimes(1);
    const probeRoot = rootWith(collection([new Error(sensitive)]), collection([true]));
    expect(await probe(probeRoot as unknown as Page, "composer", opts)).toMatchObject({
      found: false,
      complete: false,
      reason: "visibility_unreadable",
    });
    expect(probeRoot.next).toHaveBeenCalledTimes(1);
  });
  it("collection count changes after visibility reads are incomplete", async () => {
    const loc = collection([true]);
    loc.count.mockResolvedValueOnce(1).mockResolvedValue(2);
    expect(await scanVisible(loc as unknown as Locator)).toMatchObject({
      kind: "incomplete",
      reason: "collection_changed",
    });
  });
  it("visibility changing without a count change is incomplete", async () => {
    const loc = collection([true]);
    loc.items[0]?.isVisible.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await scanVisible(loc as unknown as Locator)).toMatchObject({
      kind: "incomplete",
      reason: "collection_changed",
      complete: false,
    });
  });
  it("count read failure does not enable fallback", async () => {
    const loc = collection([]);
    loc.count.mockRejectedValue(new Error("private count error"));
    const root = rootWith(loc, collection([true]));
    expect(await probe(root as unknown as Page, "composer", opts)).toMatchObject({
      found: false,
      complete: false,
      reason: "count_unreadable",
    });
    expect(root.next).toHaveBeenCalledTimes(1);
  });
  it("candidate construction and enabled read errors keep probe nonthrowing and fail closed", async () => {
    const root = {
      locator: () => {
        throw new Error("private");
      },
    };
    expect(await probe(root as unknown as Page, "composer", opts)).toMatchObject({
      found: false,
      complete: false,
      reason: "candidate_unreadable",
    });
    const loc = collection([true]);
    loc.items[0]?.isEnabled.mockRejectedValue(new Error("private"));
    expect(await probe(rootWith(loc) as unknown as Page, "composer", opts)).toMatchObject({
      found: false,
      complete: false,
      reason: "enabled_unreadable",
    });
  });
});
