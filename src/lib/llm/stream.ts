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
}

export async function readOpenAIStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (fullText: string) => void,
): Promise<StreamResult> {
  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;

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
      if (parsed.usage) {
        inputTokens = parsed.usage.prompt_tokens ?? 0;
        outputTokens = parsed.usage.completion_tokens ?? 0;
      }
    } catch {}
  });

  return { text: fullText, inputTokens, outputTokens };
}

export async function readClaudeStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (fullText: string) => void,
): Promise<StreamResult> {
  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;

  await readLines(body, (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
        fullText += parsed.delta.text ?? '';
        onChunk(fullText);
      }
      if (parsed.type === 'message_start') inputTokens = parsed.message?.usage?.input_tokens ?? 0;
      if (parsed.type === 'message_delta') outputTokens = parsed.usage?.output_tokens ?? 0;
    } catch {}
  });

  return { text: fullText, inputTokens, outputTokens };
}

export async function readGeminiStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (fullText: string) => void,
): Promise<StreamResult> {
  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;

  await readLines(body, (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    try {
      const parsed = JSON.parse(data);
      const delta = (parsed.candidates?.[0]?.content?.parts ?? [])
        .map((p: { text?: string }) => p.text ?? '').join('');
      if (delta) { fullText += delta; onChunk(fullText); }
      if (parsed.usageMetadata) {
        inputTokens = parsed.usageMetadata.promptTokenCount ?? 0;
        outputTokens = parsed.usageMetadata.candidatesTokenCount ?? 0;
      }
    } catch {}
  });

  return { text: fullText, inputTokens, outputTokens };
}
