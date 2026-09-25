/**
 * Runs `task` repeatedly, waiting `intervalMs` after each run settles before starting the next.
 * Unlike setInterval, a slow run (e.g. doctor's PowerShell/WMI probe on Windows) can never overlap
 * the next one, so child processes cannot pile up and results cannot arrive out of order.
 */
export function startPollLoop(task: () => Promise<void>, intervalMs: number, schedule: typeof setTimeout = setTimeout): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try { await task(); } catch (error) { console.warn("Bridge GUI: poll failed; retrying next tick", error); }
    if (!stopped) timer = schedule(() => { void tick(); }, intervalMs);
  };
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
