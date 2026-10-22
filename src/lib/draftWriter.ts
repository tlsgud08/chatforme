/** One write at a time. Intermediate snapshots are replaced by the newest text. */
export function createDraftWriter(write: (text: string) => Promise<void>, interval = 1000) {
  let pending: string | undefined;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastError: unknown;
  let stopped = false;
  const drain = async () => {
    if (running) return running;
    running = (async () => {
      while (pending !== undefined) {
        const value = pending;
        pending = undefined;
        try { await write(value); lastError = undefined; }
        catch (error) { lastError = error; }
      }
    })();
    try { await running; } finally { running = undefined; }
  };
  return {
    push(text: string) {
      if (stopped) return;
      pending = text;
      if (!timer && !running) timer = setTimeout(() => { timer = undefined; void drain(); }, interval);
    },
    async flush() {
      clearTimeout(timer); timer = undefined;
      await drain();
      if (pending !== undefined) await drain();
      if (lastError) throw lastError;
    },
    async stop() {
      stopped = true;
      clearTimeout(timer); timer = undefined;
      pending = undefined;
      await running;
    },
  };
}
