// SSE 스트림 공통 리더 유틸리티

async function readLines(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    }
  } finally {
    reader.releaseLock();
  }
}

export interface StreamResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

export async function readOpenAIStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (fullText: string) => void,
): Promise<StreamResult> {
  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cost = 0;

  await readLines(body, (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        fullText += delta;
        onChunk(fullText);
      }
      const usage = parsed.usage;
      if (usage) {
        inputTokens = usage.prompt_tokens ?? 0;
        outputTokens = usage.completion_tokens ?? 0;
        cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
        cost = usage.cost ?? 0;
      }
    } catch {}
  });

  return { text: fullText, inputTokens, outputTokens, cacheCreationTokens: 0, cacheReadTokens, cost };
}
