/** Races `p` against a bound so a hung Playwright call (evaluate() has no built-in timeout option)
 * can never block a caller indefinitely — Codex review of A-110, High: an unbounded evaluate()
 * against a half-dead CDP connection could hang attach() forever while holding the bridge lock,
 * recreating exactly the "stuck, looks alive" failure this change was meant to fix. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
