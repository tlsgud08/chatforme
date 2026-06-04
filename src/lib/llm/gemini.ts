import type { GenerateOptions, GenerateResult, LLMAdapter, SystemParts } from './types';
import { readGeminiStream } from './stream';

// 정적인 것부터 동적인 것 순으로 concat
function buildSystem(parts: SystemParts): string {
  return [parts.core, parts.persona, parts.userNote, parts.summary, parts.keywords]
    .filter(Boolean)
    .join('\n\n');
}

// Google Gemini generateContent API — role은 'user' | 'model'
export const geminiAdapter: LLMAdapter = {
  provider: 'gemini',
  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const system = buildSystem(opts.systemParts);
    const streaming = !!opts.onChunk;
    const endpoint = streaming ? 'streamGenerateContent' : 'generateContent';
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:${endpoint}?key=` +
      encodeURIComponent(opts.apiKey) +
      (streaming ? '&alt=sse' : '');

    const contents = opts.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const res = await fetch(url, {
      method: 'POST',
      signal: opts.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        generationConfig: opts.maxOutputTokens !== null ? { maxOutputTokens: opts.maxOutputTokens } : {},
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini API 오류 (${res.status}): ${err}`);
    }

    if (streaming) {
      const { text, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } =
        await readGeminiStream(res.body!, opts.onChunk!);
      return { text, usage: { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } };
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
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };
  },
};
