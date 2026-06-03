import type { GenerateOptions, GenerateResult, LLMAdapter } from './types';

// OpenAI Chat Completions API — 브라우저 직접 호출
export const openaiAdapter: LLMAdapter = {
  provider: 'openai',
  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const messages = [
      ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
      ...opts.messages,
    ];

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        ...(opts.maxOutputTokens !== null && { max_tokens: opts.maxOutputTokens }),
        messages,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API 오류 (${res.status}): ${err}`);
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
