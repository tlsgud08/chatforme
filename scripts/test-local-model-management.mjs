import assert from 'node:assert/strict';
import test from 'node:test';
import { managementFixture } from './model-management-fixture.mjs';
import { OWNER, OTHER, tick } from './local-gateway-fixture.mjs';

test('remote management is opt-in; catalog excludes LM Link and embedding variants', async () => {
  const disabled = await managementFixture({ enabled: false });
  try { assert.equal((await disabled.load()).status, 403); assert.equal((await disabled.rpc({ action: 'model-catalog' })).code, 'LOCAL_MANAGEMENT_DISABLED'); assert.equal(disabled.calls.length, 0); }
  finally { await disabled.close(); }
  const f = await managementFixture({ variants: [
    { modelKey: 'variant-local', maxContextLength: 32768, deviceIdentifier: null, type: 'llm' },
    { modelKey: 'variant-remote', deviceIdentifier: 'remote', type: 'llm' },
    { modelKey: 'variant-embedding', deviceIdentifier: null, type: 'embedding' },
  ] });
  try {
    f.installed.push({ modelKey: 'remote', deviceIdentifier: 'other-PC' });
    f.installed.push({ modelKey: 'family', deviceIdentifier: null, variants: ['variant-local'] });
    const catalog = await f.rpc({ action: 'model-catalog' });
    assert.equal(catalog.managementEnabled, true); assert.equal(catalog.models[0].instanceId, f.first.instanceReference);
    assert.deepEqual(catalog.downloaded.map(m => m.key), ['fixture/local', 'fixture/second', 'family', 'variant-local']);
    assert(!JSON.stringify(catalog).includes('flashAttention'));
    f.active.length = 0;
    assert.equal((await f.rpc({ action: 'model-catalog' })).models.length, 0, 'remote load works before any LLM is resident');
    const firstLoad = await f.load(); assert.equal((await f.poll(firstLoad.id)).state, 'complete');
  } finally { await f.close(); }
});

test('only installed models and supported integer contexts load; other models stay resident', async () => {
  const f = await managementFixture();
  try {
    for (const [request, code] of [[{ modelKey: 'https://arbitrary.test/model' }, 'LOCAL_MODEL_NOT_INSTALLED'],
      [{ contextLength: 9999999 }, 'LOCAL_INVALID_CONTEXT'], [{ contextLength: 1024.5 }, 'LOCAL_INVALID_CONTEXT'], [{ contextLength: -1 }, 'LOCAL_INVALID_CONTEXT']]) {
      const started = await f.load(request); assert.equal((await f.poll(started.id)).error.code, code);
    }
    assert(!f.calls.some(c => c[0] === 'load' || c[0] === 'unload'));
    const requestId = crypto.randomUUID(), started = await f.load({}, requestId), duplicate = await f.load({}, requestId);
    assert.equal(started.id, duplicate.id); const done = await f.poll(started.id);
    assert.equal(done.kind, 'load'); assert.equal(done.progress, 1); assert.equal(done.state, 'complete'); assert.equal(done.result.contextLength, 131072);
    assert(f.active.includes(f.first)); assert.equal(f.calls.filter(c => c[0] === 'load').length, 1);
    assert.equal(f.calls.find(c => c[0] === 'load')[2].deviceIdentifier, null);
    assert.equal((await f.rpc({ action: 'poll', id: started.id, cursor: 0 }, OTHER)).status, 404);
    assert.equal((await f.rpc({ action: 'cancel', id: started.id }, OTHER)).status, 404);
  } finally { await f.close(); }
});

test('reload checks immutable instance, preserves other load settings, and never unloads another model', async () => {
  const f = await managementFixture();
  try {
    const second = f.makeModel('fixture/second');
    const request = { modelKey: 'fixture/local', targetId: f.first.identifier, expectedInstance: f.first.instanceReference, contextLength: 131072 };
    const stale = await f.load({ ...request, expectedInstance: 'stale' }); assert.equal((await f.poll(stale.id)).error.code, 'LOCAL_MODEL_CHANGED');
    assert(!f.calls.some(c => c[0] === 'unload'));
    const started = await f.load(request); assert.equal((await f.poll(started.id)).state, 'complete');
    assert.deepEqual(f.calls.filter(c => c[0] === 'unload'), [['unload', 'fixture/local']]);
    const config = f.calls.find(c => c[0] === 'load')[2].config;
    assert.deepEqual(config, { contextLength: 131072, flashAttention: true, gpu: { ratio: 0.75 } });
    assert.equal(f.calls.find(c => c[0] === 'load')[2].ttl, 600);
    assert(f.active.includes(second));
    const again = await f.load(request); assert.equal((await f.poll(again.id)).error.code, 'LOCAL_MODEL_CHANGED');
  } finally { await f.close(); }
});

test('global lock prevents generation/load overlap across users and is released after cancellation', async () => {
  let loading = false;
  const f = await managementFixture({ load: opts => new Promise((_, reject) => { loading = true; opts.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }); }) });
  try {
    const started = await f.load();
    for (let i = 0; i < 100 && !loading; i++) await tick(); assert(loading);
    const other = await f.rpc({ action: 'start', requestId: crypto.randomUUID(), request: { model: 'fixture/local', messages: [{ role: 'user', content: 'Hello' }] } }, OTHER);
    assert.equal(other.code, 'LOCAL_BUSY'); assert.equal((await f.load()).code, 'LOCAL_BUSY');
    const status = await f.rpc({ action: 'poll', id: started.id, cursor: 0 }); assert.equal(status.progress, 0.4);
    await f.rpc({ action: 'cancel', id: started.id }); assert.equal((await f.poll(started.id)).error.code, 'LOCAL_CANCELLED');
    const next = await f.start(); assert.equal((await f.poll(next.id)).state, 'complete');
  } finally { await f.close(); }
  const generating = await managementFixture({ respond: res => res.write(': waiting\n\n') });
  try {
    const started = await generating.start(); assert.equal((await generating.load()).code, 'LOCAL_BUSY');
    await generating.rpc({ action: 'cancel', id: started.id }); await generating.poll(started.id);
  } finally { await generating.close(); }
});

test('failed reload and clamped context report actual failure, hide SDK details, and preserve unrelated instances', async () => {
  for (const options of [{ load: async () => { throw Error('/Users/private/API_TOKEN GPU ERROR'); } }, { actualContext: 4096 }]) {
    const f = await managementFixture(options);
    try {
      const other = f.makeModel('unrelated-model');
      const started = await f.load({ modelKey: 'fixture/local', targetId: f.first.identifier, expectedInstance: f.first.instanceReference });
      const result = await f.poll(started.id); assert.equal(result.state, 'error');
      assert.equal(result.error.code, options.actualContext ? 'LOCAL_CONTEXT_NOT_APPLIED' : 'LOCAL_MODEL_LOAD_FAILED');
      assert(!JSON.stringify(result).includes('/Users/private')); assert(!JSON.stringify(result).includes('API_TOKEN')); assert(f.active.includes(other));
    } finally { await f.close(); }
  }
});

test('cancellation while unloading holds the lock until unload ends and never starts a replacement load', async () => {
  let release, unloading = false;
  const f = await managementFixture({ unload: () => new Promise(resolve => { unloading = true; release = resolve; }) });
  try {
    const started = await f.load({ modelKey: 'fixture/local', targetId: f.first.identifier, expectedInstance: f.first.instanceReference });
    for (let i = 0; i < 100 && !unloading; i++) await tick(); assert(unloading);
    await f.rpc({ action: 'cancel', id: started.id }); assert.equal((await f.start()).code, 'LOCAL_BUSY');
    release(); const result = await f.poll(started.id); assert.equal(result.error.code, 'LOCAL_CANCELLED');
    assert(!f.calls.some(c => c[0] === 'load')); assert.match(result.error.message, /언로드/);
  } finally { release?.(); await f.close(); }
});
