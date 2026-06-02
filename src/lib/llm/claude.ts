import type { GenerateOptions, GenerateResult, LLMAdapter } from './types';

// Anthropic Messages API — 브라우저 직접 호출
// 'anthropic-dangerous-direct-browser-access' 헤더로 CORS 허용
export const claudeAdapter: LLMAdapter = {
  provider: 'claude',
  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxOutputTokens,
        system: opts.system || undefined,
        messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Claude API 오류 (${res.status}): ${err}`);
    }

    const data = await res.json();
    const text = (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('');

    return {
      text,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
    };
  },
};
