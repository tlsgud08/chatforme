import type { GenerateOptions, GenerateResult, LLMAdapter } from './types';
import { readClaudeStream } from './stream';

// Anthropic Messages API — max_tokens는 필수 필드. null(무제한)이면 8192로 대체.
export const claudeAdapter: LLMAdapter = {
  provider: 'claude',
  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const streaming = !!opts.onChunk;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxOutputTokens ?? 8192,
        stream: streaming,
        system: opts.system || undefined,
        messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Claude API 오류 (${res.status}): ${err}`);
    }

    if (streaming) {
      const { text, inputTokens, outputTokens } = await readClaudeStream(res.body!, opts.onChunk!);
      return { text, usage: { inputTokens, outputTokens } };
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
