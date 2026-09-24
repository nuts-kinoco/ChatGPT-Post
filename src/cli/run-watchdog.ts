/**
 * Detached Windows children do not receive a useful graceful signal from taskkill.
 * This watchdog is therefore owned by `run` itself.  It starts once the request's
 * timeout is validated and allows this fixed cleanup budget for a terminal result,
 * browser detach, and lock release before exiting the process.
 */
export const RUN_CLEANUP_BUDGET_MS = 30_000;
/** A hung forceTerminal() must never turn the watchdog into another infinite wait. */
export const RUN_WATCHDOG_HARD_GRACE_MS = 15_000;

export interface WatchdogTarget {
  forceTerminal(cause: string): Promise<{ exitCode: number }>;
  /** Best-effort, synchronous token-checked release for the hard-exit path. */
  releaseLockSync?(): void;
}

export interface WatchdogDeps {
  setTimer?: typeof setTimeout;
  terminate?: (code: number) => never | undefined;
}

export function armRunWatchdog(
  remainingRunMs: number,
  target: WatchdogTarget,
  deps: WatchdogDeps = {},
): () => void {
  const setTimer = deps.setTimer ?? setTimeout;
  const terminate = deps.terminate ?? ((code: number) => process.exit(code));
  const delay = Math.max(0, remainingRunMs) + RUN_CLEANUP_BUDGET_MS;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let terminated = false;
  const finish = (code: number) => {
    if (terminated) return;
    terminated = true;
    if (hardTimer) clearTimeout(hardTimer);
    terminate(code);
  };
  const timer = setTimer(() => {
    hardTimer = setTimer(() => {
      // Do not await filesystem or CDP I/O here. If the process still owns the exact
      // token, this can free the next job before process.exit(); otherwise a dead PID
      // makes the retained lock reclaimable under the normal stale-lock policy.
      target.releaseLockSync?.();
      finish(1);
    }, RUN_WATCHDOG_HARD_GRACE_MS);
    hardTimer.unref?.();
    void target
      .forceTerminal(`watchdog deadline exceeded (${RUN_CLEANUP_BUDGET_MS} ms cleanup budget)`)
      .then((outcome) => finish(outcome.exitCode))
      .catch(() => finish(1));
  }, delay);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
    if (hardTimer) clearTimeout(hardTimer);
  };
}

/** Owns the mutually exclusive pre-submit and post-submit watchdog windows. */
export class RunWatchdog {
  private cancelCurrent: (() => void) | null = null;

  constructor(
    private readonly target: WatchdogTarget,
    private readonly deps: WatchdogDeps = {},
  ) {}

  /** Arms the overall bound for validation-complete work before the submit click. */
  armBeforeSubmit(preSubmitBudgetMs: number): void {
    this.replace(preSubmitBudgetMs);
  }

  /** Re-anchors the response/completion bound at the confirmed submit dispatch. */
  armAfterSubmit(timeoutMs: number, stabilizationAndExtractionBudgetMs: number): void {
    this.replace(timeoutMs + stabilizationAndExtractionBudgetMs);
  }

  cancel(): void {
    this.cancelCurrent?.();
    this.cancelCurrent = null;
  }

  private replace(remainingRunMs: number): void {
    this.cancel();
    this.cancelCurrent = armRunWatchdog(remainingRunMs, this.target, this.deps);
  }
}
