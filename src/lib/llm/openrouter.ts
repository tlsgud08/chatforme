import type { GenerateOptions, GenerateResult, LLMAdapter, SystemParts } from './types';
import { readOpenAIStream } from './stream';

type CacheControl = { type: 'ephemeral' };
type TextBlock = { type: 'text'; text: string; cache_control?: CacheControl };

// Anthropic 모델: 레이어별 content block + cache_control (명시적 캐싱)
function buildAnthropicSystemBlocks(parts: SystemParts): TextBlock[] {
  const blocks: TextBlock[] = [];
  if (parts.core)     blocks.push({ type: 'text', text: parts.core,     cache_control: { type: 'ephemeral' } });
  if (parts.persona)  blocks.push({ type: 'text', text: parts.persona,  cache_control: { type: 'ephemeral' } });
  if (parts.userNote) blocks.push({ type: 'text', text: parts.userNote, cache_control: { type: 'ephemeral' } });
  if (parts.summary)  blocks.push({ type: 'text', text: parts.summary,  cache_control: { type: 'ephemeral' } });
  if (parts.keywords) blocks.push({ type: 'text', text: parts.keywords });
  return blocks;
}

// 그 외 모델: 단순 문자열 (prefix caching 자동)
function buildPlainSystem(parts: SystemParts): string {
  return [parts.core, parts.persona, parts.userNote, parts.summary, parts.keywords]
    .filter(Boolean)
    .join('\n\n');
}

// OpenRouter — OpenAI 호환 API. max_tokens 생략 시 모델 기본값 사용.
export const openrouterAdapter: LLMAdapter = {
  provider: 'openrouter',
  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const isAnthropic = opts.model.startsWith('anthropic/');

    let systemMessages: Array<{ role: 'system'; content: string | TextBlock[] }> = [];
    if (isAnthropic) {
      const blocks = buildAnthropicSystemBlocks(opts.systemParts);
      if (blocks.length > 0) systemMessages = [{ role: 'system', content: blocks }];
    } else {
      const text = buildPlainSystem(opts.systemParts);
      if (text) systemMessages = [{ role: 'system', content: text }];
    }

    const messages = [...systemMessages, ...opts.messages];

    const streaming = !!opts.onChunk;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
        'HTTP-Referer': window.location.origin,
        'X-Title': 'ChatForMe',
      },
      body: JSON.stringify({
        model: opts.model,
        stream: streaming,
        usage: { include: true }, // 응답에 실제 청구 비용(cost) 포함
        ...(streaming && { stream_options: { include_usage: true } }),
        ...(opts.maxOutputTokens !== null && { max_tokens: opts.maxOutputTokens }),
        messages,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenRouter API 오류 (${res.status}): ${err}`);
    }

    if (streaming) {
      const { text, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, cost } =
        await readOpenAIStream(res.body!, opts.onChunk!);
      return { text, usage: { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, cost } };
    }

    const data = await res.json();
    const text: string = data.choices?.[0]?.message?.content ?? '';

    return {
      text,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cacheCreationTokens: 0,
        cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cost: data.usage?.cost ?? 0,
      },
    };
  },
};
