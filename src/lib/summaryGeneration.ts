import type { GenerateOptions, GenerateResult, Usage } from './llm/types';
import type { Provider } from '@/types/db';

export const SUMMARY_USER_STOP = 'inuchat:summary-user-stop';
export function isUserSummaryStop(signal?: AbortSignal): boolean {
  return !!signal?.aborted && signal.reason === SUMMARY_USER_STOP;
}

type Generate = (provider: Provider, options: GenerateOptions) => Promise<GenerateResult>;
type SummaryResult = Pick<GenerateResult, 'text' | 'usage' | 'finishReason' | 'nativeFinishReason'>;

/** Only an explicit summary stop may turn an aborted stream into a saved note. */
export async function generateSummaryResponse(generate: Generate, options: GenerateOptions): Promise<SummaryResult> {
  let partial = '';
  let usageReported = false;
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cost: 0, cacheCreationTokens: null, cacheReadTokens: null };
  const stopped = (): SummaryResult => ({
    text: partial, usage, finishReason: 'user_stop',
    nativeFinishReason: usageReported ? 'client_abort' : 'client_abort_usage_unreported',
  });
  try {
    if (options.signal?.aborted) {
      if (isUserSummaryStop(options.signal)) return stopped();
      throw options.signal.reason ?? new DOMException('요약 생성을 중단했습니다.', 'AbortError');
    }
    const result = await generate('openrouter', {
      ...options,
      onChunk: text => {
        // Ignore buffered events processed after the user clicked stop.
        if (options.signal?.aborted) return;
        partial = text;
        try { options.onChunk?.(text); } catch { /* Preview rendering must not discard a paid response. */ }
      },
      onUsage: value => { usage = value; usageReported = true; },
    });
    if (isUserSummaryStop(options.signal)) return stopped();
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('요약 생성을 중단했습니다.', 'AbortError');
    return result;
  } catch (error) {
    if (isUserSummaryStop(options.signal)) return stopped();
    throw error; // Account resets, outages and provider errors keep their existing failure semantics.
  }
}
