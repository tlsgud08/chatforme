import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();
const frame = delta => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n';
const tick = () => new Promise(resolve => setImmediate(resolve));
globalThis.window = { location: { origin: 'https://progress.test' } };
try {
  const { createGenerationProgress } = await server.ssrLoadModule('/src/lib/generationProgress.ts');
  const { default: Status } = await server.ssrLoadModule('/src/components/GenerationStatus.tsx');
  const { default: MessageContent } = await server.ssrLoadModule('/src/components/MessageContent.tsx');
  const { readOpenAIStream } = await server.ssrLoadModule('/src/lib/llm/stream.ts');
  const { openrouterAdapter } = await server.ssrLoadModule('/src/lib/llm/openrouter.ts');
  const progress = createGenerationProgress(), notifications = [];
  const unsubscribe = progress.subscribe(() => notifications.push(progress.getSnapshot()));
  const status = savingOnly => renderToStaticMarkup(React.createElement(Status, { progress, savingOnly }));
  const body = content => renderToStaticMarkup(React.createElement(MessageContent, { content, role: 'assistant', status: 'streaming', showImages: true, generationProgress: progress }));
  const attempt = progress.start();
  assert(status().includes('대화 준비 중…'));
  let respond, controller, requests = 0;
  globalThis.fetch = () => {
    requests++;
    return new Promise(resolve => { respond = () => resolve(new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { 'content-type': 'text/event-stream' } })); });
  };
  const phases = [], texts = [];
  const options = { apiKey: 'fixture', model: 'test/model', sessionId: 'fixture', reasoning: { send: false }, maxOutputTokens: 100,
    systemParts: { core: '', persona: '', userNote: '', summary: '', keywords: '' }, messages: [{ role: 'user', content: 'test' }],
    onChunk: text => texts.push(text), onPhase: phase => { phases.push(phase); attempt.onPhase(phase); } };
  const pending = openrouterAdapter.generate(options);
  assert(status().includes('모델에 요청 중…'));
  respond(); await tick();
  assert(status().includes('응답 기다리는 중…'));
  controller.enqueue(encoder.encode(': keep-alive\n\n' + frame({ role: 'assistant' }) + frame({ reasoning: '', reasoning_details: [] })));
  await tick();
  assert.equal(progress.getSnapshot(), 'waiting', 'metadata and keep-alives never imply thinking');
  assert.equal(texts.length, 0);
  controller.enqueue(encoder.encode(frame({ reasoning: 'PRIVATE_REASONING_NEVER_RENDER' })));
  await tick();
  assert(status().includes('추론 중…')); assert.equal(texts.length, 0);
  attempt.onPhase('model-headers'); assert.equal(progress.getSnapshot(), 'reasoning', 'late headers cannot regress state');
  controller.enqueue(encoder.encode(Array.from({ length: 1000 }, () => frame({ content: '가' })).join('')));
  await tick();
  assert.equal(progress.getSnapshot(), 'receiving');
  assert.equal(status(true), '', 'no saving label while content is arriving');
  assert(body('{{theme::').includes('답변 받는 중…'), 'hidden partial theme directives keep local progress, not a remote-tab placeholder');
  controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
  const result = await pending;
  assert.equal(result.text, '가'.repeat(1000)); assert.equal(texts.length, 1000, 'all tokens still reach the existing body callback');
  assert(!JSON.stringify(result).includes('PRIVATE_REASONING_NEVER_RENDER'));
  assert.equal(requests, 1, 'status never makes another provider request');
  assert.equal(progress.getSnapshot(), 'receiving', 'stream completion does not falsely confirm a DB save');
  attempt.advance('saving');
  assert(body('답변 본문').includes('답변 저장 중…')); assert(body('답변 본문').includes('답변 본문'));
  for (const phase of ['model-event', 'model-reasoning', 'first-content']) attempt.onPhase(phase);
  assert.equal(progress.getSnapshot(), 'saving');
  assert.equal(new Set(phases).size, phases.length, 'provider observer is called once per phase, not per token');
  assert.deepEqual(notifications, ['preparing', 'requesting', 'waiting', 'reasoning', 'receiving', 'saving']);
  attempt.finish(); assert.equal(progress.getSnapshot(), 'idle');
  const next = progress.start(); attempt.onPhase('first-content'); attempt.finish();
  assert.equal(progress.getSnapshot(), 'preparing', 'old attempts cannot overwrite a retry');
  next.finish(); unsubscribe();
  const count = notifications.length, detached = progress.start(); detached.onPhase('model-request'); detached.finish();
  assert.equal(notifications.length, count, 'unmounted status listeners are removed');
  const stopBadListener = progress.subscribe(() => { throw Error('observer failure'); });
  assert.doesNotThrow(() => progress.start().finish()); stopBadListener();

  // Provider-specific explicit reasoning shapes all emit one boolean signal only.
  for (const delta of [
    { reasoning_content: 'PRIVATE' },
    { reasoning_details: [{ type: 'reasoning.text', text: 'PRIVATE' }] },
    { reasoning_details: [{ type: 'reasoning.summary', summary: 'PRIVATE' }] },
    { reasoning_details: [{ type: 'reasoning.encrypted', data: '[REDACTED]' }] },
  ]) {
    let signals = 0;
    const stream = new Response(frame(delta) + frame(delta) + frame({ content: 'answer' }) + 'data: [DONE]\n\n');
    const parsed = await readOpenAIStream(stream.body, () => {}, undefined, () => signals++);
    assert.equal(signals, 1); assert.equal(parsed.text, 'answer');
  }
  let falseSignals = 0;
  await readOpenAIStream(new Response(frame({ reasoning_details: [{ type: 'reasoning.text', text: '' }] }) + frame({ content: 'ok' }) + frame({ reasoning: 'late reasoning' }) + 'data: [DONE]\n\n').body, () => {}, undefined, () => falseSignals++);
  assert.equal(falseSignals, 0, 'empty reasoning and post-body metadata do not change progress');
  assert.equal((await readOpenAIStream(new Response(frame({ reasoning: 'PRIVATE' }) + frame({ content: 'ok' }) + 'data: [DONE]\n\n').body, () => {}, undefined, () => { throw Error('observer'); })).text, 'ok');
  await assert.rejects(readOpenAIStream(new Response(frame({ content: 'partial' })).body, () => {}), /완료 신호/);
  console.log('Generation progress: actual header/event/reasoning/body/save phases, 1000 unchanged chunks/one request, bounded notifications, retries/unmount, no reasoning leakage, hidden directives and observer failures passed');
} finally { globalThis.fetch = originalFetch; delete globalThis.window; await server.close(); }
