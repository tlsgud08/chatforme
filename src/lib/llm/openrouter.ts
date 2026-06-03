import type { GenerateOptions, GenerateResult, LLMAdapter } from './types';

// OpenRouter — OpenAI 호환 API. 키 하나로 Claude/Gemini/GPT 등 모든 모델 사용.
export const openrouterAdapter: LLMAdapter = {
  provider: 'openrouter',
  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const messages = [
      ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
      ...opts.messages,
    ];

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
        'HTTP-Referer': window.location.origin,
        'X-Title': 'ChatForMe',
      },
      body: JSON.stringify({
        model: opts.model,
        ...(opts.maxOutputTokens !== null && { max_tokens: opts.maxOutputTokens }),
        messages,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenRouter API 오류 (${res.status}): ${err}`);
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
