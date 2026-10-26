// Bounded, tab-local timings only. Never pass prompts, keys, URLs or account IDs.
type Operation = 'send' | 'works' | 'session-counts' | 'message-page';
type Stage = 'context' | 'settings' | 'themes' | 'prompt' | 'start-save' | 'model-request'
  | 'model-headers' | 'model-event' | 'first-content' | 'model-complete' | 'save' | 'data';
type Outcome = 'complete' | 'failed' | 'cancelled';
interface Timing {
  operation: Operation; build: string; at: string; elapsed: number;
  stages: Partial<Record<Stage, number>>; outcome: Outcome;
}
const STORAGE_KEY = 'inuchat.timings.v1';
const MAX_RECORDS = 30;
const records: Timing[] = [];
try {
  const previous = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
  if (Array.isArray(previous)) records.push(...previous.filter((row): row is Timing => row
    && ['send', 'works', 'session-counts', 'message-page'].includes(row.operation)
    && ['complete', 'failed', 'cancelled'].includes(row.outcome)
    && typeof row.build === 'string' && row.build.length < 80 && typeof row.at === 'string'
    && typeof row.elapsed === 'number' && row.stages && typeof row.stages === 'object').slice(-MAX_RECORDS)
    .map(row => ({ operation: row.operation, build: row.build, at: row.at, elapsed: row.elapsed,
      outcome: row.outcome, stages: Object.fromEntries(Object.entries(row.stages)
        .filter(([key, value]) => ['context', 'settings', 'themes', 'prompt', 'start-save', 'model-request',
          'model-headers', 'model-event', 'first-content', 'model-complete', 'save', 'data'].includes(key)
          && typeof value === 'number' && Number.isFinite(value))) })));
} catch { /* Storage can be disabled or contain an older invalid record. */ }
const clock = () => typeof performance === 'undefined' ? Date.now() : performance.now();

export function startOperation(operation: Operation) {
  const start = clock();
  const stages: Timing['stages'] = {};
  const at = new Date().toISOString();
  let finished = false;
  return {
    mark(stage: Stage) {
      if (!finished && stages[stage] === undefined) stages[stage] = Math.round(clock() - start);
    },
    describe() {
      return JSON.stringify({ build: typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'test',
        elapsed: Math.round(clock() - start), stages });
    },
    finish(outcome: Outcome) {
      if (finished) return;
      finished = true;
      records.push({ operation, build: typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'test', at,
        elapsed: Math.round(clock() - start), stages: { ...stages }, outcome });
      if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(records)); } catch { /* Diagnostics cannot fail an operation. */ }
    },
  };
}

export async function measureOperation<T>(operation: Operation, read: () => Promise<T>): Promise<T> {
  const timing = startOperation(operation);
  try {
    const result = await read(); timing.mark('data'); timing.finish('complete'); return result;
  } catch (error) {
    timing.finish(error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed');
    throw error;
  }
}
