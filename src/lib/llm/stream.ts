// SSE 스트림 공통 리더 유틸리티

async function readLines(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const READ_TIMEOUT_MS = 8 * 60_000;
  try {
    while (true) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('스트리밍 응답이 8분 동안 도착하지 않았습니다.')), READ_TIMEOUT_MS);
      });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), stalled]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      const { done, value } = result;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) onLine(buffer);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface StreamResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  cost: number;
  generationId: string | null;
  upstreamProvider: string | null;
}

export async function readOpenAIStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (fullText: string) => void,
  onEvent?: () => void,
  onReasoning?: () => void,
): Promise<StreamResult> {
  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | null = null;
  let cacheCreationTokens: number | null = null;
  let cost = 0;
  let receivedDone = false;
  let finishReason: string | null = null;
  let generationId: string | null = null;
  let upstreamProvider: string | null = null;
  let reportedReasoning = false;

  await readLines(body, (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    onEvent?.();
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') { receivedDone = true; return; }
    try {
      const parsed = JSON.parse(data);
      if (typeof parsed.id === 'string') generationId = parsed.id;
      if (typeof parsed.provider === 'string') upstreamProvider = parsed.provider;
      if (parsed.error) {
        const message = parsed.error.message ?? parsed.error.code ?? JSON.stringify(parsed.error);
        throw new Error(`OpenRouter 스트리밍 오류: ${message}`);
      }
      const delta = parsed.choices?.[0]?.delta;
      // Observe only the presence of actual reasoning data. Never retain it,
      // request extra reasoning, or infer thinking from headers/keep-alives.
      if (onReasoning && !reportedReasoning && !fullText) {
        const nonempty = (value: unknown) => typeof value === 'string' && value.length > 0;
        if (nonempty(delta?.reasoning) || nonempty(delta?.reasoning_content)
          || (Array.isArray(delta?.reasoning_details) && delta.reasoning_details.some((detail: unknown) => {
            if (!detail || typeof detail !== 'object') return false;
            const row = detail as Record<string, unknown>;
            return (row.type === 'reasoning.text' && nonempty(row.text))
              || (row.type === 'reasoning.summary' && nonempty(row.summary))
              || (row.type === 'reasoning.encrypted' && nonempty(row.data));
          }))) {
          reportedReasoning = true;
          try { onReasoning(); } catch { /* A status observer must not interrupt a paid response. */ }
        }
      }
      if (typeof delta?.content === 'string' && delta.content) {
        fullText += delta.content;
        onChunk(fullText);
      }
      const usage = parsed.usage;
      if (usage) {
        inputTokens = usage.prompt_tokens ?? 0;
        outputTokens = usage.completion_tokens ?? 0;
        cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? null;
        cacheCreationTokens = usage.prompt_tokens_details?.cache_write_tokens
          ?? usage.cache_creation_input_tokens
          ?? usage.cache_creation_tokens
          ?? null;
        cost = usage.cost ?? 0;
      }
      const reason = parsed.choices?.[0]?.finish_reason;
      if (typeof reason === 'string' && reason) finishReason = reason;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('OpenRouter 스트리밍 오류:')) throw error;
      throw new Error(`스트리밍 이벤트를 해석할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  if (!receivedDone) throw new Error(`스트리밍 연결이 정상 완료 신호 없이 종료되었습니다${finishReason ? ` (finish_reason: ${finishReason})` : ''}.`);
  if (!fullText.trim()) throw new Error('모델이 빈 응답을 반환했습니다.');

  return { text: fullText, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, cost, generationId, upstreamProvider };
}
