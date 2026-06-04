import type { GenerateOptions, GenerateResult, LLMAdapter } from './types';
import { readOpenAIStream } from './stream';

// OpenAI Chat Completions API — max_tokens 생략 시 모델 기본값 사용
export const openaiAdapter: LLMAdapter = {
  provider: 'openai',
  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const messages = [
      ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
      ...opts.messages,
    ];

    const streaming = !!opts.onChunk;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        stream: streaming,
        ...(streaming && { stream_options: { include_usage: true } }),
        ...(opts.maxOutputTokens !== null && { max_tokens: opts.maxOutputTokens }),
        messages,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API 오류 (${res.status}): ${err}`);
    }

    if (streaming) {
      const { text, inputTokens, outputTokens } = await readOpenAIStream(res.body!, opts.onChunk!);
      return { text, usage: { inputTokens, outputTokens } };
    }

    const data = await res.json();
    const text: string = data.choices?.[0]?.message?.content ?? '';

    return {
      text,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  },
};
