import { describe, expect, it, vi } from "vitest";
import type { BoundQuotaSnapshot } from "../../src/state/task-quota.js";
import { deploymentQuotaPort } from "../../src/ui/deployment-operations.js";
import { UiOperationsService } from "../../src/ui/operations.js";

const observedAt = "2026-10-03T09:00:00.000Z";
const snapshot: BoundQuotaSnapshot = {
  version: "bridge-quota-snapshot-1",
  providerId: "codex",
  observation: {
    source: "provider",
    observedAt,
    windowEndsAt: "2026-10-03T10:00:00.000Z",
    remainingPercent: 73,
    maxAgeSeconds: 60,
  },
  fallback: { preauthorized: true, maxStarts: 1, maxRunSeconds: 30 },
  strictMoneyBudget: false,
};
describe("provider-bound UI quota projection", () => {
  it("reads the shared Codex snapshot without polling and exposes no billing estimate", async () => {
    const read = vi.fn(() => structuredClone(snapshot));
    const operations = new UiOperationsService(
      { quota: deploymentQuotaPort(read) },
      { now: () => new Date(observedAt) },
    );
    const setup = await operations.setup();
    expect(read).toHaveBeenCalledTimes(1);
    expect(setup.quotas).toMatchObject({
      state: "available",
      value: [
        {
          providerId: "codex",
          verification: "provider_observed",
          remainingPercent: 73,
          billingEstimate: null,
        },
      ],
    });
  });
  it.each([null, "claude", "antigravity", "chatgpt"])(
    "does not relabel Codex evidence as %s quota",
    async (providerId) => {
      const operations = new UiOperationsService(
        {
          quota: deploymentQuotaPort(
            () => ({ ...structuredClone(snapshot), providerId }) as BoundQuotaSnapshot,
          ),
        },
        { now: () => new Date(observedAt) },
      );
      expect((await operations.setup()).quotas).toMatchObject({
        state: "available",
        value: [
          {
            providerId: "unknown",
            verification: "unknown",
            remainingPercent: null,
            observedAt: null,
            boundedFallback: { maxStarts: 1, maxRunSeconds: 30 },
          },
        ],
      });
    },
  );
  it("rejects provider-labelled evidence on unsupported injected routes even without the helper", async () => {
    const operations = new UiOperationsService(
      { quota: { read: () => [{ ...snapshot.observation, providerId: "claude" }] } },
      { now: () => new Date(observedAt) },
    );
    expect((await operations.setup()).quotas).toMatchObject({
      state: "available",
      value: [
        { providerId: "claude", verification: "unknown", remainingPercent: null, observedAt: null },
      ],
    });
  });
});
