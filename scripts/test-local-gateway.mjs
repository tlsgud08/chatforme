import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, OWNER, OTHER, frame, tick } from './local-gateway-fixture.mjs';
import { createGateway } from '../tools/lm-studio-gateway/gateway.mjs';

test('gateway authentication, actual loaded context, unloaded exclusion and loopback restriction', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.rpc({ action: 'models' }, OWNER, 'invalid')).status, 401);
    assert.equal((await f.rpc({ action: 'models' }, OWNER, 'é'.repeat(52))).status, 401);
    const data = await f.rpc({ action: 'models' });
    assert.equal(data.models.length, 1); assert.equal(data.models[0].contextLength, 131072);
    f.setContext(4096); assert.equal((await f.rpc({ action: 'models' })).models[0].contextLength, 4096);
    f.unload(); assert.equal((await f.rpc({ action: 'models' })).models.length, 0);
    assert.throws(() => createGateway({ secret: 'x'.repeat(32), lmUrl: 'https://example.com', inspector: {} }), /loopback/);
  } finally { await f.close(); }
});

test('110K token history reaches completions intact; safe max_tokens, supported sampling, zero billing and split UTF8 SSE', async () => {
  const f = await fixture();
  try {
    const messages = [{ role: 'system', content: 'STABLE PREFIX' }, { role: 'user', content: 'BEGIN ' + 'token '.repeat(110000) + 'END' }];
    const { id } = await f.start({ messages, sampling: { temperature: 1.1, top_p: 0.9, frequency_penalty: 0.2 } });
    const result = await f.poll(id);
    assert.equal(result.state, 'complete'); assert.equal(result.delta, '안녕🙂'); assert.equal(result.usage.cost, 0);
    assert.equal(result.usage.cacheReadTokens, 80); assert(result.context.promptTokens > 100000);
    assert.deepEqual(f.received[0].messages, messages); assert.equal(f.received[0].top_p, 0.9); assert.equal(f.received[0].temperature, 1.1);
    for (const key of ['frequency_penalty', 'reasoning', 'cache_control', 'session_id', 'usage', 'provider']) assert(!(key in f.received[0]));
    assert.equal(f.received[0].stream_options.include_usage, true);
  } finally { await f.close(); }
});

test('overflow and unknown context fail closed before inference, without truncation or model loading', async () => {
  const f = await fixture();
  try {
    f.setContext(1024);
    let started = await f.start({ messages: [{ role: 'user', content: 'token '.repeat(1000) }] });
    let result = await f.poll(started.id);
    assert.equal(result.error.code, 'LOCAL_CONTEXT_OVERFLOW'); assert.match(result.error.message, /삭제·축약하지 않았습니다/); assert.equal(f.received.length, 0);
    f.setContext(NaN); started = await f.start(); result = await f.poll(started.id);
    assert.equal(result.error.code, 'LOCAL_CONTEXT_UNKNOWN'); assert.equal(f.received.length, 0);
    f.unload(); started = await f.start(); result = await f.poll(started.id);
    assert.equal(result.error.code, 'LOCAL_MODEL_UNLOADED'); assert.equal(f.received.length, 0);
  } finally { await f.close(); }
});

test('output reservation uses remaining real context when unspecified and honors explicit token field profile', async () => {
  const f = await fixture({ gateway: { profiles: { 'fixture/local': { supportedParameters: ['frequency_penalty'], maxTokensField: 'max_completion_tokens' } } } });
  try {
    f.setContext(128); const { id } = await f.start({ maxOutputTokens: null, sampling: { temperature: 1, frequency_penalty: 0.3 } });
    const result = await f.poll(id); assert.equal(result.state, 'complete');
    const wire = f.received[0]; assert.equal(wire.max_completion_tokens, 128 - result.context.promptTokens - 32);
    assert(!('max_tokens' in wire)); assert(!('temperature' in wire)); assert.equal(wire.frequency_penalty, 0.3);
  } finally { await f.close(); }
});

test('inline reasoning split across chunks is excluded; separate reasoning never enters narrative', async () => {
  const f = await fixture({ gateway: { profiles: { 'fixture/local': { reasoningFormat: 'think-tags' } } }, respond: res => {
    for (const content of ['<thi', 'nk>PRIVATE', ' THINKING</th', 'ink>Visible ', 'story']) res.write(frame({ choices: [{ delta: { content } }] }));
    res.end(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + frame('[DONE]'));
  } });
  try { const { id } = await f.start(); const result = await f.poll(id); assert.equal(result.delta, 'Visible story'); assert.equal(result.state, 'complete'); }
  finally { await f.close(); }
});

test('truncated/error streams preserve partial output as errors and never report a successful response', async () => {
  for (const error of [false, true]) {
    const f = await fixture({ respond: res => res.end(frame({ choices: [{ delta: { content: 'partial' } }] }) + (error ? frame({ error: { message: 'PRIVATE SERVER DETAILS' } }) : '')) });
    try {
      const { id } = await f.start(); const result = await f.poll(id);
      assert.equal(result.state, 'error'); assert.equal(result.delta, 'partial'); assert.equal(result.usage.cost, 0);
      assert(!JSON.stringify(result.error).includes('PRIVATE')); assert.equal(result.error.code, error ? 'LOCAL_MODEL_ERROR' : 'LOCAL_STREAM_ERROR');
    } finally { await f.close(); }
  }
});

test('owner isolation, idempotent start, busy guard, cancellation and orphan lease', async () => {
  const f = await fixture({ respond: res => res.write(': waiting\n\n') });
  try {
    const requestId = crypto.randomUUID(), first = await f.start({}, requestId), duplicate = await f.start({}, requestId);
    assert.equal(first.id, duplicate.id); assert.equal((await f.start()).code, 'LOCAL_BUSY');
    assert.equal((await f.rpc({ action: 'poll', id: first.id, cursor: 0 }, OTHER)).status, 404);
    assert.equal((await f.rpc({ action: 'cancel', id: first.id }, OTHER)).status, 404);
    assert.equal((await f.rpc({ action: 'poll', id: first.id, cursor: -1 })).status, 400);
    for (let i = 0; i < 50 && !f.received.length; i++) await tick();
    await f.rpc({ action: 'cancel', id: first.id });
    assert.equal((await f.poll(first.id)).error.code, 'LOCAL_CANCELLED');
    const next = await f.start(); f.advance(91000);
    assert.equal((await f.poll(next.id)).error.code, 'LOCAL_CANCELLED');
    f.advance(11 * 60000); assert.equal((await f.rpc({ action: 'poll', id: next.id, cursor: 0 })).status, 404);
    assert(f.received.length <= 2);
  } finally { await f.close(); }
});

test('cancellation during SDK token counting releases the job without ever starting inference', async () => {
  const f = await fixture();
  try {
    const count = f.model.countTokens;
    let reached = false;
    f.model.countTokens = () => { reached = true; return new Promise(() => {}); };
    const { id } = await f.start();
    for (let i = 0; i < 50 && !reached; i++) await tick();
    assert(reached); await f.rpc({ action: 'cancel', id });
    assert.equal((await f.poll(id)).error.code, 'LOCAL_CANCELLED'); assert.equal(f.received.length, 0);
    f.model.countTokens = count;
    const next = await f.start(); assert.equal((await f.poll(next.id)).state, 'complete');
  } finally { await f.close(); }
});
