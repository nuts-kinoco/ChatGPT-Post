import type { ChatGptPage } from "./page.js";

/**
 * The shared, bounded auth observation used by both `doctor` and the daemon's idle keepalive.
 * It navigates only to the ChatGPT home page and never types or clicks.
 */
export async function observeAuthWithRetry(
  page: Pick<ChatGptPage, "navigateAndObserveAuth">,
  crashed: { cause: string | null } = { cause: null },
  attempts = 3,
): Promise<Awaited<ReturnType<ChatGptPage["navigateAndObserveAuth"]>>> {
  let last: Awaited<ReturnType<ChatGptPage["navigateAndObserveAuth"]>> = {
    kind: "NOT_READY",
    cause: "not attempted",
  };
  for (let i = 0; i < attempts; i++) {
    if (crashed.cause) return last;
    last = await page.navigateAndObserveAuth().catch(
      (err): Awaited<ReturnType<ChatGptPage["navigateAndObserveAuth"]>> => ({
        kind: "NOT_READY",
        cause: `threw: ${(err as Error).message}`,
      }),
    );
    if (crashed.cause || last.kind !== "NOT_READY") return last;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 1500 * (i + 1)));
  }
  return last;
}
