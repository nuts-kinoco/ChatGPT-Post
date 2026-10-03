/** One owned shutdown attempt; window hiding/collapse never enters this path. */
export function createProductShutdown(options: {
  close(): Promise<void>;
  ready(): void;
  failed(): void;
}) {
  let finished = false;
  let pending: Promise<void> | null = null;
  return {
    beforeQuit(event: { preventDefault(): void }): void {
      if (finished) return;
      event.preventDefault();
      if (pending) return;
      pending = Promise.resolve()
        .then(() => options.close())
        .then(() => { finished = true; options.ready(); }, () => { options.failed(); })
        .finally(() => { pending = null; });
    },
  };
}
