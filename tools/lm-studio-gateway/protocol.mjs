// Shared contract; no LM Studio address, credential or prompt is included in errors.
export class LocalError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const fail = (code, message, status) => { throw new LocalError(code, message, status); };
export const publicError = error => error instanceof LocalError
  ? { code: error.code, message: error.message }
  : { code: 'LOCAL_OFFLINE', message: 'Local 오프라인: PC, LM Studio 서버 및 HTTPS 터널 연결을 확인하세요.' };

export function validateCompletion(value) {
  if (!value || typeof value !== 'object' || typeof value.model !== 'string' || !value.model || value.model.length > 512)
    fail('INVALID_REQUEST', 'Local 모델을 선택하세요.');
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > 100_000)
    fail('INVALID_REQUEST', '메시지 형식이 올바르지 않습니다.');
  const messages = value.messages.map(message => {
    if (!['system', 'user', 'assistant'].includes(message?.role) || typeof message.content !== 'string')
      fail('INVALID_REQUEST', 'Local은 텍스트 메시지만 지원합니다.');
    return { role: message.role, content: message.content };
  });
  const maxOutputTokens = value.maxOutputTokens ?? null;
  if (maxOutputTokens !== null && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1))
    fail('INVALID_REQUEST', '출력 토큰 한도는 양의 정수여야 합니다.');
  const sampling = {};
  for (const [key, min, max] of [['temperature', 0, 2], ['top_p', 0, 1], ['frequency_penalty', -2, 2]]) {
    if (value.sampling?.[key] !== undefined) {
      const n = value.sampling[key];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) fail('INVALID_REQUEST', `${key} 값이 범위를 벗어났습니다.`);
      sampling[key] = n;
    }
  }
  return { model: value.model, messages, maxOutputTokens, sampling };
}

/** Incremental filter for models that return reasoning inline, even across token boundaries. */
export function thinkFilter() {
  let buffer = '', thinking = false;
  return (chunk, final = false) => {
    buffer += chunk;
    let output = '';
    while (buffer) {
      const marker = thinking ? '</think>' : '<think>';
      const index = buffer.indexOf(marker);
      if (index >= 0) {
        if (!thinking) output += buffer.slice(0, index);
        buffer = buffer.slice(index + marker.length); thinking = !thinking; continue;
      }
      let keep = 0;
      if (!final) for (let n = 1; n < marker.length; n++) if (buffer.endsWith(marker.slice(0, n))) keep = n;
      if (!thinking) output += buffer.slice(0, buffer.length - keep);
      buffer = keep ? buffer.slice(-keep) : '';
      break;
    }
    return output;
  };
}

/** LM Studio uses OpenAI SSE; reject truncated streams and never mix reasoning into content. */
export async function consumeCompletion(body, job, profile) {
  const reader = body.getReader(), decoder = new TextDecoder();
  const filter = profile.reasoningFormat === 'think-tags' ? thinkFilter() : chunk => chunk;
  let buffer = '', done = false;
  const event = line => {
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw) return;
    if (raw === '[DONE]') { done = true; return; }
    let data;
    try { data = JSON.parse(raw); } catch { fail('LOCAL_STREAM_ERROR', 'Local 스트리밍 이벤트를 해석할 수 없습니다.', 502); }
    if (data.error) fail('LOCAL_MODEL_ERROR', 'Local 모델이 생성 중 오류를 반환했습니다. LM Studio에서 모델 설정을 확인하세요.', 502);
    const choice = data.choices?.[0], delta = choice?.delta;
    if (delta?.reasoning || delta?.reasoning_content) job.reasoning = true;
    if (typeof delta?.content === 'string') job.text += filter(delta.content);
    else if (Array.isArray(delta?.content)) for (const part of delta.content) if (part.type === 'text') job.text += filter(part.text ?? '');
    if (typeof choice?.finish_reason === 'string') job.finishReason = choice.finish_reason;
    if (data.usage) {
      const finite = n => Number.isFinite(n) && n >= 0 ? n : 0;
      job.usage = { inputTokens: finite(data.usage.prompt_tokens), outputTokens: finite(data.usage.completion_tokens),
        cacheReadTokens: data.usage.prompt_tokens_details?.cached_tokens ?? null, cacheCreationTokens: null, cost: 0 };
    }
  };
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) event(line.trim());
    }
    buffer += decoder.decode(); if (buffer.trim()) event(buffer.trim());
    job.text += filter('', true);
    if (!done) fail('LOCAL_STREAM_ERROR', 'Local 연결이 정상 완료 신호 없이 종료되었습니다.', 502);
    if (!job.text.trim()) fail('LOCAL_EMPTY_RESPONSE', 'Local 모델이 본문 없이 종료했습니다. 출력 한도와 reasoning 형식을 확인하세요.', 502);
    if (job.finishReason === 'error') fail('LOCAL_MODEL_ERROR', 'Local 모델 생성이 오류로 종료되었습니다.', 502);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
