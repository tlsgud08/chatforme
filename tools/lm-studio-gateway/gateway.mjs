import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { LocalError, fail, publicError, validateCompletion, consumeCompletion } from './protocol.mjs';

const MAX_BODY = 16 * 1024 * 1024; // No artificial 100K token cap.
const OUTPUT_MARGIN = 32; // Special-token safety margin, never removed from the prompt.

function abortable(task, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createGateway({ secret, lmUrl, lmToken = '', inspector, profiles = {}, defaultOutputTokens = 4096,
  fetchImpl = fetch, now = Date.now, leaseMs = 90_000, retentionMs = 10 * 60_000 }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('GATEWAY_SECRET must contain at least 32 characters.');
  const base = new URL(lmUrl);
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/')
    throw new Error('LM_STUDIO_URL must be a loopback HTTP origin.');
  if (!Number.isSafeInteger(defaultOutputTokens) || defaultOutputTokens < 1) throw new Error('Invalid default output tokens.');
  const jobs = new Map();
  const headers = { 'content-type': 'application/json', ...(lmToken && { authorization: `Bearer ${lmToken}` }) };
  const profileFor = id => {
    const p = profiles[id] ?? {};
    const supportedParameters = p.supportedParameters ?? ['temperature', 'top_p'];
    if (!Array.isArray(supportedParameters) || supportedParameters.some(k => !['temperature', 'top_p', 'frequency_penalty'].includes(k))
      || !['separate', 'think-tags'].includes(p.reasoningFormat ?? 'separate')
      || !['max_tokens', 'max_completion_tokens'].includes(p.maxTokensField ?? 'max_tokens')) throw new Error('Invalid model profile');
    return { supportedParameters, reasoningFormat: p.reasoningFormat ?? 'separate', maxTokensField: p.maxTokensField ?? 'max_tokens' };
  };
  async function models(signal) {
    const response = await fetchImpl(new URL('/v1/models', base), { headers, signal });
    if (!response.ok) fail('LOCAL_OFFLINE', 'Local 모델 목록을 읽지 못했습니다. LM Studio 서버와 인증을 확인하세요.', 503);
    const catalog = await response.json();
    const loaded = await abortable(inspector.listLoaded(), signal);
    const result = [];
    for (const model of loaded) {
      // /v1/models can include unloaded JIT models. Never load or evict a model automatically.
      if (!catalog.data?.some(item => item.id === model.identifier)) continue;
      const contextLength = await abortable(model.getContextLength(), signal);
      if (!Number.isSafeInteger(contextLength) || contextLength < 1) continue;
      result.push({ id: model.identifier, name: model.displayName || model.identifier, contextLength, ...profileFor(model.identifier) });
    }
    return { online: true, models: result };
  }
  async function run(job, input) {
    try {
      const loaded = await abortable(inspector.listLoaded(), job.controller.signal);
      const model = loaded.find(item => item.identifier === input.model);
      if (!model) fail('LOCAL_MODEL_UNLOADED', '선택한 Local 모델이 로드되지 않았습니다. LM Studio에서 다시 로드하세요.', 409);
      const contextLength = await abortable(model.getContextLength(), job.controller.signal);
      if (!Number.isSafeInteger(contextLength) || contextLength < 1) fail('LOCAL_CONTEXT_UNKNOWN', '서버의 실제 컨텍스트 한도를 확인할 수 없어 전송을 중단했습니다.', 409);
      const formatted = await abortable(model.applyPromptTemplate(input.messages), job.controller.signal);
      const promptTokens = await abortable(model.countTokens(formatted), job.controller.signal);
      if (!Number.isSafeInteger(promptTokens) || promptTokens < 1) fail('LOCAL_CONTEXT_UNKNOWN', '모델 토큰 수를 검증할 수 없어 전송을 중단했습니다.', 409);
      const available = contextLength - promptTokens - OUTPUT_MARGIN;
      const maxTokens = input.maxOutputTokens ?? Math.min(defaultOutputTokens, available);
      if (available < 1 || maxTokens > available) fail('LOCAL_CONTEXT_OVERFLOW',
        `컨텍스트 초과: 입력 ${promptTokens.toLocaleString()} + 출력 ${Math.max(1, maxTokens).toLocaleString()} + 여유 ${OUTPUT_MARGIN} / 실제 한도 ${contextLength.toLocaleString()} 토큰. 대화는 삭제·축약하지 않았습니다. 모델 컨텍스트 또는 출력 한도를 직접 조정하세요.`, 409);
      job.context = { promptTokens, contextLength, maxOutputTokens: maxTokens };
      const profile = profileFor(input.model);
      const sampling = Object.fromEntries(Object.entries(input.sampling).filter(([key]) => profile.supportedParameters.includes(key)));
      job.controller.signal.throwIfAborted();
      const response = await fetchImpl(new URL('/v1/chat/completions', base), { method: 'POST', headers, signal: job.controller.signal,
        body: JSON.stringify({ model: input.model, messages: input.messages, stream: true, stream_options: { include_usage: true },
          [profile.maxTokensField]: maxTokens, ...sampling }) });
      job.headers = true;
      if (!response.ok || !response.body) fail('LOCAL_MODEL_ERROR', `Local 모델 요청 실패 (${response.status}). LM Studio에서 프롬프트 템플릿과 모델 설정을 확인하세요.`, 502);
      await consumeCompletion(response.body, job, profile);
      job.state = 'complete';
    } catch (error) {
      job.error = job.controller.signal.aborted ? { code: 'LOCAL_CANCELLED', message: 'Local 생성을 중단했습니다.' } : publicError(error);
      job.state = 'error';
    } finally { job.completedAt = now(); }
  }
  function sweep() {
    for (const [id, job] of jobs) {
      if (job.state === 'running' && now() - job.lastPoll > leaseMs) job.controller.abort();
      if (job.completedAt && now() - job.completedAt > retentionMs) jobs.delete(id);
    }
  }
  const interval = setInterval(sweep, 10_000); interval.unref();
  async function dispatch(input, owner) {
    sweep();
    if (input.action === 'models') return models(AbortSignal.timeout(15_000));
    if (input.action === 'start') {
      const request = validateCompletion(input.request);
      const requestId = input.requestId;
      if (typeof requestId !== 'string' || !/^[\w-]{16,80}$/.test(requestId)) fail('INVALID_REQUEST', '요청 ID가 올바르지 않습니다.');
      const existing = [...jobs.values()].find(j => j.owner === owner && j.requestId === requestId);
      if (existing) return { id: existing.id }; // Lost start-response retry cannot create a second generation.
      if ([...jobs.values()].some(j => j.owner === owner && j.state === 'running')) fail('LOCAL_BUSY', '이미 진행 중인 Local 생성이 있습니다.', 429);
      if (jobs.size >= 100 || [...jobs.values()].filter(j => j.state === 'running').length >= 2) fail('LOCAL_BUSY', 'Local PC가 사용 중입니다. 잠시 후 다시 시도하세요.', 429);
      const job = { id: randomUUID(), requestId, owner, text: '', state: 'running', controller: new AbortController(), lastPoll: now(), completedAt: null,
        finishReason: null, headers: false, reasoning: false, context: null,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheCreationTokens: null, cost: 0 } };
      jobs.set(job.id, job); void run(job, request); return { id: job.id };
    }
    const job = typeof input.id === 'string' ? jobs.get(input.id) : null;
    if (!job || job.owner !== owner) fail('LOCAL_JOB_NOT_FOUND', 'Local 생성 정보를 찾을 수 없습니다. 수신한 답변은 기존 복구 규칙으로 보관합니다.', 404);
    if (input.action === 'cancel') { job.controller.abort(); return { cancelled: true }; }
    if (input.action !== 'poll') fail('INVALID_REQUEST', '지원하지 않는 요청입니다.');
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0 || input.cursor > job.text.length) fail('INVALID_REQUEST', '수신 위치가 올바르지 않습니다.');
    job.lastPoll = now();
    return { id: job.id, state: job.state, delta: job.text.slice(input.cursor), cursor: job.text.length, usage: job.usage,
      finishReason: job.finishReason, error: job.error, headers: job.headers, reasoning: job.reasoning, context: job.context };
  }
  const server = createServer(async (req, res) => {
    const respond = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    const authorization = req.headers.authorization ?? '';
    const expected = `Bearer ${secret}`;
    const received = Buffer.from(authorization), credential = Buffer.from(expected);
    const authenticated = received.length === credential.length && timingSafeEqual(received, credential);
    if (!authenticated) { respond(401, { code: 'UNAUTHORIZED', message: '인증이 필요합니다.' }); return; }
    if (req.method !== 'POST' || req.url !== '/rpc') { respond(404, { code: 'NOT_FOUND' }); return; }
    const owner = req.headers['x-chatforme-user-id'];
    if (typeof owner !== 'string' || !/^[a-f\d-]{36}$/i.test(owner)) { respond(403, { code: 'FORBIDDEN' }); return; }
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) fail('REQUEST_TOO_LARGE', '요청이 16 MiB를 초과했습니다. 대화는 자동으로 자르지 않습니다.', 413); chunks.push(chunk); }
      let input; try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('INVALID_REQUEST', 'JSON 요청을 확인하세요.'); }
      if (!input || typeof input !== 'object') fail('INVALID_REQUEST', '요청을 확인하세요.');
      respond(200, await dispatch(input, owner));
    } catch (error) { respond(error instanceof LocalError ? error.status : 503, publicError(error)); }
  });
  return { server, dispatch, sweep, close: () => { clearInterval(interval); for (const job of jobs.values()) job.controller.abort(); server.close(); } };
}
