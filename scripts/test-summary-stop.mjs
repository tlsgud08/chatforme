import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
globalThis.window = { location: { origin: 'https://summary-stop.test' } };
const tick = () => new Promise(resolve => setImmediate(resolve));
const frame = value => new TextEncoder().encode('data: ' + JSON.stringify(value) + '\n\n');
try {
  const { generate } = await server.ssrLoadModule('/src/lib/llm/index.ts');
  const { generateSummaryResponse, SUMMARY_USER_STOP } = await server.ssrLoadModule('/src/lib/summaryGeneration.ts');
  const options = { apiKey: 'mock-only', model: 'fixture/model', sessionId: 'fixture:summary', maxOutputTokens: null,
    reasoning: { send: false }, systemParts: { core: '', persona: '', userNote: '', summary: '', keywords: '' }, messages: [{ role: 'user', content: 'fixture' }] };
  let calls = 0;
  async function receive({ usage = true, thinkingOnly = false, accountReset = false, broken = false, complete = false } = {}) {
    const abort = new AbortController(), previews = [];
    let socket;
    globalThis.fetch = async (_url, request) => {
      calls++;
      const body = JSON.parse(request.body);
      assert.equal(body.stream, true); assert.equal(body.stream_options.include_usage, true);
      assert(!('max_tokens' in body));
      const stream = new ReadableStream({ start(controller) { socket = controller; } });
      request.signal.addEventListener('abort', () => socket.error(new DOMException('aborted', 'AbortError')), { once: true });
      return new Response(stream);
    };
    const task = generateSummaryResponse(generate, { ...options, signal: abort.signal, onChunk: text => previews.push(text) });
    await tick();
    socket.enqueue(frame({ id: 'fixture-generation', choices: [{ delta: { reasoning: 'PRIVATE_THINKING' } }] }));
    if (usage) socket.enqueue(frame({ usage: { prompt_tokens: 100, completion_tokens: 7, cost: 0.012 } }));
    if (!thinkingOnly) {
      socket.enqueue(frame({ choices: [{ delta: { content: '[핵심 서사 및 맥락]\n먼저 받은 내용' } }] }));
      await tick();
      assert.equal(previews.at(-1), '[핵심 서사 및 맥락]\n먼저 받은 내용', 'preview updates before stream completion');
      socket.enqueue(frame({ choices: [{ delta: { content: '과 다음 조각' } }] }));
    }
    await tick();
    if (broken) socket.close();
    else if (complete) {
      socket.enqueue(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      socket.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); socket.close();
    } else abort.abort(accountReset ? 'account reset' : SUMMARY_USER_STOP);
    if (accountReset || broken) { await assert.rejects(task); return; }
    const result = await task;
    assert(!result.text.includes('PRIVATE_THINKING'), 'reasoning never enters the note or preview');
    assert.equal(result.text, thinkingOnly ? '' : previews.at(-1));
    assert.equal(result.finishReason, complete ? 'stop' : 'user_stop');
    if (usage) assert.equal(result.usage.cost, 0.012, 'reported usage survives user cancellation');
    if (!usage && !complete) assert.equal(result.nativeFinishReason, 'client_abort_usage_unreported');
    return result;
  }
  await receive(); await receive({ usage: false }); await receive({ thinkingOnly: true });
  await receive({ accountReset: true }); await receive({ broken: true }); await receive({ complete: true });
  assert.equal(calls, 6, 'exactly one generation per attempt; no paid retries');

  const alreadyStopped = new AbortController(); alreadyStopped.abort(SUMMARY_USER_STOP);
  const beforeRequest = calls;
  const empty = await generateSummaryResponse(generate, { ...options, signal: alreadyStopped.signal });
  assert.equal(empty.text, ''); assert.equal(calls, beforeRequest, 'stopping during preparation never starts a model request');

  const abort = new AbortController();
  const late = await generateSummaryResponse(async (_provider, request) => {
    request.onChunk('KEEP'); abort.abort(SUMMARY_USER_STOP); request.onChunk('KEEP LATE');
    throw new DOMException('aborted', 'AbortError');
  }, { ...options, signal: abort.signal });
  assert.equal(late.text, 'KEEP', 'buffered content processed after stop is excluded');
  console.log('Summary stop: actual SSE streaming/preview, stop before/during output, last reported usage, empty reasoning-only stop, account cancellation, broken streams, completion and no retries passed.');
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  await server.close();
}
