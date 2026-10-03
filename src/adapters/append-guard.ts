/** Host callback only. A task/payload cannot supply this synchronous publication fence. */
export type FinalAppendGuard = () => void;
export function applyFinalAppendGuard(guard?: FinalAppendGuard): void {
  if (!guard) return;
  const result: unknown = guard();
  if (result !== undefined) {
    // An accidental async host callback is denied, and its late rejection must not become unhandled.
    void Promise.resolve(result).catch(() => undefined);
    throw new Error("transport_append_guard_must_be_synchronous");
  }
}
