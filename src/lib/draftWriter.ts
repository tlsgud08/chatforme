/** One write at a time. Intermediate snapshots are replaced by the newest text. */
export function createDraftWriter(write: (text: string) => Promise<void>, interval = 1000) {
  let pending: string | undefined;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastError: unknown;
  let stopped = false;
  let flushing = false;
  const schedule = () => {
    if (!stopped && !flushing && pending !== undefined && !timer && !running) {
      timer = setTimeout(() => { timer = undefined; void drain(); }, interval);
    }
  };
  const drain = async () => {
    if (running) return running;
    if (pending === undefined) return;
    const value = pending;
    pending = undefined;
    running = (async () => {
      try { await write(value); lastError = undefined; }
      catch (error) { lastError = error; }
    })();
    try { await running; } finally { running = undefined; schedule(); }
  };
  return {
    push(text: string) {
      if (stopped) return;
      pending = text;
      schedule();
    },
    async flush() {
      clearTimeout(timer); timer = undefined;
      flushing = true;
      try {
        await running;
        while (pending !== undefined) await drain();
        if (lastError) throw lastError;
      } finally { flushing = false; schedule(); }
    },
    async stop() {
      stopped = true;
      clearTimeout(timer); timer = undefined;
      pending = undefined;
      await running;
    },
  };
}
