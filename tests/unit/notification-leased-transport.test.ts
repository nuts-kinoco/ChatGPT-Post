import { describe, expect, it } from "vitest";
import {
  type PreparedNotificationTransport,
  prepareLeasedNotificationTransport,
} from "../../src/adapters/notification-transports.js";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("fixture_value_missing");
  return value;
}
const text = "Bridge notification test. No task content is included.";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
describe("late-bound notification transport", () => {
  it("does not resolve a secret or construct an inner transport before authorized send", async () => {
    let prepares = 0,
      sends = 0;
    const t = required(
      prepareLeasedNotificationTransport(
        {
          isCurrent: () => true,
          leaseSignal: new AbortController().signal,
          prepare: async () => {
            prepares++;
            return {
              send: async () => {
                sends++;
                return "delivered";
              },
            };
          },
        },
        new AbortController().signal,
      ),
    );
    expect(prepares).toBe(0);
    expect(await t.send(text, new AbortController().signal)).toBe("not_sent");
    expect(prepares).toBe(0);
    expect(sends).toBe(0);
  });
  it.each(["authority", "epoch", "abort"])(
    "rechecks %s after unresolved inner preparation, so stale work has zero effects",
    async (kind) => {
      const wait = deferred<PreparedNotificationTransport>();
      let current = true,
        authority = true,
        sends = 0,
        guards = 0;
      const lease = new AbortController();
      const t = required(
        prepareLeasedNotificationTransport(
          {
            isCurrent: () => current,
            leaseSignal: lease.signal,
            prepare: async () => wait.promise,
          },
          new AbortController().signal,
        ),
      );
      const result = t.send(text, new AbortController().signal, () => {
        guards++;
        return authority;
      });
      if (kind === "authority") authority = false;
      else if (kind === "epoch") current = false;
      else lease.abort();
      wait.resolve({
        send: async () => {
          sends++;
          return "delivered";
        },
      });
      expect(await result).toBe("not_sent");
      expect(sends).toBe(0);
      if (kind === "authority") expect(guards).toBe(2);
    },
  );
  it("final guard is synchronous immediately before the one allowed inner effect and handles are single-use", async () => {
    const order: string[] = [];
    const t = required(
      prepareLeasedNotificationTransport(
        {
          isCurrent: () => true,
          leaseSignal: new AbortController().signal,
          prepare: async () => {
            order.push("prepared");
            return {
              send: async () => {
                order.push("effect");
                return "delivered";
              },
            };
          },
        },
        new AbortController().signal,
      ),
    );
    const guard = () => {
      order.push("guard");
      return true;
    };
    expect(await t.send(text, new AbortController().signal, guard)).toBe("delivered");
    expect(order).toEqual(["guard", "prepared", "guard", "effect"]);
    expect(await t.send(text, new AbortController().signal, guard)).toBe("not_sent");
    expect(order.filter((x) => x === "effect")).toHaveLength(1);
  });
  it("expired original budget cannot reset during inner preparation", async () => {
    const wait = deferred<PreparedNotificationTransport>();
    let received = 0,
      sends = 0;
    const t = required(
      prepareLeasedNotificationTransport(
        {
          totalTimeoutMs: 10,
          isCurrent: () => true,
          leaseSignal: new AbortController().signal,
          prepare: async (_signal, remaining) => {
            received = remaining;
            return wait.promise;
          },
        },
        new AbortController().signal,
      ),
    );
    const result = t.send(text, new AbortController().signal, () => true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    wait.resolve({
      send: async () => {
        sends++;
        return "delivered";
      },
    });
    expect(await result).toBe("not_sent");
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThanOrEqual(10);
    expect(sends).toBe(0);
  });
  it("throwing guard/sender errors remain finite outcomes without exception reflection", async () => {
    let getters = 0;
    const secretError = {
      get message() {
        getters++;
        return "SYNTHETIC_PRIVATE";
      },
      get code() {
        getters++;
        return "SYNTHETIC_PRIVATE";
      },
    };
    const t = required(
      prepareLeasedNotificationTransport(
        {
          isCurrent: () => true,
          leaseSignal: new AbortController().signal,
          prepare: async () => {
            throw secretError;
          },
        },
        new AbortController().signal,
      ),
    );
    expect(await t.send(text, new AbortController().signal, () => true)).toBe("not_sent");
    expect(getters).toBe(0);
  });
});
