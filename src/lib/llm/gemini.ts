import type { GenerateOptions, GenerateResult, LLMAdapter } from './types';

// Google Gemini generateContent API — role은 'user' | 'model'
export const geminiAdapter: LLMAdapter = {
  provider: 'gemini',
  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=` +
      encodeURIComponent(opts.apiKey);

    const contents = opts.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: opts.system ? { parts: [{ text: opts.system }] } : undefined,
        contents,
        generationConfig: opts.maxOutputTokens !== null ? { maxOutputTokens: opts.maxOutputTokens } : {},
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API 오류 (${res.status}): ${err}`);
    }

    const data = await res.json();
    const text: string = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? '')
      .join('');

    return {
      text,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  },
};
