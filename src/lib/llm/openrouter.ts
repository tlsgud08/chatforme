import type { GenerateOptions, GenerateResult, LLMAdapter, SystemParts } from './types';
import { readOpenAIStream } from './stream';
import { openRouterReasoningPayload } from './reasoningPayloads';
import { createCacheDiagnostic, diagnosticSources } from './cacheDiagnostics';

const MAX_SESSION_ID_LENGTH = 64;

function openRouterSessionId(value: string): string {
  return value.trim().slice(0, MAX_SESSION_ID_LENGTH);
}

// Stable system instructions remain a single message at the front of the payload.
function buildSystem(parts: SystemParts): string {
  return [parts.core, parts.persona, parts.userNote, parts.summary, parts.storyNotes]
    .filter(Boolean)
    .join('\n\n');
}

// OpenRouter — OpenAI 호환 API. max_tokens 생략 시 모델 기본값 사용.
export const openrouterAdapter: LLMAdapter = {
  provider: 'openrouter',
  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const system = buildSystem(opts.systemParts);
    const history = opts.messages.slice(0, -1);
    const currentInput = opts.messages.at(-1);
    const messages = [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      ...history,
      ...(opts.systemParts.keywords ? [{ role: 'system' as const, content: opts.systemParts.keywords }] : []),
      ...(currentInput ? [currentInput] : []),
    ];
    const sources = diagnosticSources(opts.systemParts, opts.messages);
    const requestId = crypto.randomUUID();

    const streaming = !!opts.onChunk;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
        'HTTP-Referer': window.location.origin,
        'X-Title': 'Inuchat',
      },
      body: JSON.stringify({
        model: opts.model,
        session_id: openRouterSessionId(opts.sessionId),
        stream: streaming,
        usage: { include: true }, // 응답에 실제 청구 비용(cost) 포함
        ...(streaming && { stream_options: { include_usage: true } }),
        ...(opts.maxOutputTokens !== null && { max_tokens: opts.maxOutputTokens }),
        ...openRouterReasoningPayload(opts.model, opts.reasoning),
        messages,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenRouter API 오류 (${res.status}): ${err}`);
    }

    if (streaming) {
      if (!res.body) throw new Error('OpenRouter 스트리밍 응답 본문이 없습니다.');
      const { text, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, cost, generationId, upstreamProvider } =
        await readOpenAIStream(res.body, opts.onChunk!);
      const usage = { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, cost };
      return { text, usage, cacheDiagnostic: await createCacheDiagnostic({ sessionId: opts.sessionId, model: opts.model, sources, usage, requestId: res.headers.get('x-request-id') ?? requestId, generationId, upstreamProvider }) };
    }

    const data = await res.json();
    const text: string = data.choices?.[0]?.message?.content ?? '';

    const usage = {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cacheCreationTokens: data.usage?.prompt_tokens_details?.cache_write_tokens
          ?? data.usage?.cache_creation_input_tokens
          ?? data.usage?.cache_creation_tokens
          ?? null,
        cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens
          ?? data.usage?.cache_read_input_tokens
          ?? null,
        cost: data.usage?.cost ?? 0,
      };
    return {
      text,
      usage,
      cacheDiagnostic: await createCacheDiagnostic({ sessionId: opts.sessionId, model: opts.model, sources, usage, requestId: res.headers.get('x-request-id') ?? requestId, generationId: typeof data.id === 'string' ? data.id : null, upstreamProvider: typeof data.provider === 'string' ? data.provider : null }),
    };
  },
};
