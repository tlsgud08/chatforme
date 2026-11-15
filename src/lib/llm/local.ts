import type { GenerateOptions, GenerateResult, LLMAdapter, Usage } from './types';
import { localRPC, LocalAPIError } from './localTransport';
import { createCacheDiagnostic, diagnosticSources } from './cacheDiagnostics';

/** Stable order; dynamic keywords go after history, independently of OpenRouter cache switches. */
export function buildLocalMessages(opts: Pick<GenerateOptions, 'systemParts' | 'messages'>) {
  const { core, persona, userNote, summary, storyNotes, keywords } = opts.systemParts;
  const system = [core, persona, userNote, summary, storyNotes].filter(Boolean).join('\n\n');
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = system ? [{ role: 'system', content: system }] : [];
  const last = opts.messages.at(-1);
  // A trailing assistant belongs to history (continuation with empty composer).
  const current = last?.role === 'user' ? last : undefined;
  const history = current ? opts.messages.slice(0, -1) : opts.messages;
  for (const { role, content } of history) messages.push({ role, content });
  if (keywords || current) messages.push({ role: 'user', content: [keywords, current?.content].filter(Boolean).join('\n\n') });
  return messages;
}
interface Poll {
  state: 'running' | 'complete' | 'error'; delta: string; cursor: number; usage: Usage;
  finishReason: string | null; error?: { code: string; message: string }; headers: boolean; reasoning: boolean;
}
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const aborted = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** Injectable RPC exercises the entire adapter without an external account or a GPU. */
export function createLocalAdapter(rpc: typeof localRPC = localRPC): LLMAdapter {
  return { provider: 'local', async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const requestId = crypto.randomUUID();
    const request = { model: opts.model, messages: buildLocalMessages(opts), maxOutputTokens: opts.maxOutputTokens,
      sampling: { ...(opts.sampling?.temperatureSend && { temperature: opts.sampling.temperature }),
        ...(opts.sampling?.frequencyPenaltySend && { frequency_penalty: opts.sampling.frequencyPenalty }),
        ...(opts.sampling?.topPSend && { top_p: opts.sampling.topP }) } };
    let id = '', text = '', cursor = 0, complete = false;
    const phases = new Set<string>();
    const phase = (p: Parameters<NonNullable<GenerateOptions['onPhase']>>[0]) => {
      if (phases.has(p)) return; phases.add(p); try { opts.onPhase?.(p); } catch { /* Observer only. */ }
    };
    // Do not abort the short start RPC: retain its ticket even if stopped during preparation,
    // then cancel it explicitly. An abandoned job also expires its 90-second polling lease.
    phase('model-request');
    try {
      opts.signal?.throwIfAborted();
      ({ id } = await rpc<{ id: string }>({ action: 'start', requestId, request }));
      while (true) {
        opts.signal?.throwIfAborted();
        const poll = await rpc<Poll>({ action: 'poll', id, cursor }, opts.signal);
        opts.signal?.throwIfAborted();
        if (poll.headers) phase('model-headers');
        if (poll.reasoning) phase('model-reasoning');
        phase('model-event');
        if (poll.delta) { text += poll.delta; cursor = poll.cursor; phase('first-content'); opts.onChunk?.(text); }
        const usage: Usage = { ...poll.usage, cost: 0 };
        try { opts.onUsage?.(usage); } catch { /* Observer only. */ }
        if (poll.state === 'error') throw new LocalAPIError(poll.error?.code ?? 'LOCAL_STREAM_ERROR', poll.error?.message ?? 'Local 생성에 실패했습니다.');
        if (poll.state === 'complete') {
          if (!text.trim()) throw new LocalAPIError('LOCAL_EMPTY_RESPONSE', 'Local 모델이 빈 응답을 반환했습니다.');
          complete = true; phase('model-complete');
          return { text, finishReason: poll.finishReason, nativeFinishReason: poll.finishReason, usage,
            cacheDiagnostic: await createCacheDiagnostic({ sessionId: `local:${opts.sessionId}`, model: opts.model,
              sources: diagnosticSources(opts.systemParts, opts.messages), usage, requestId, generationId: id, upstreamProvider: 'LM Studio' }) };
        }
        await pause(500, opts.signal);
      }
    } finally {
      if (id && !complete) void rpc({ action: 'cancel', id }).catch(() => {});
    }
  } };
}
export const localAdapter = createLocalAdapter();
