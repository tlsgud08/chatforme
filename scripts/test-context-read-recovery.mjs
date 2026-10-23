import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';

// Exercise the locked SDK's real HTTP/retry implementation, not a fake builder.
const requests = [];
let failures = 0, status = 200, controller;
const client = createClient('https://context-check.test', 'mock-anon-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: async (input, init) => {
    init.signal?.throwIfAborted();
    const url = new URL(input);
    requests.push({ url, method: init.method, body: init.body });
    if (failures-- > 0) {
      if (controller) setTimeout(() => controller.abort(), 0);
      throw new TypeError('Load failed');
    }
    const data = status !== 200 ? { message: 'denied', code: status === 404 ? 'PGRST202' : '42501' }
      : url.pathname.endsWith('/session_message_page')
        ? { messages: [{ id: 'u1', content: 'unchanged dialogue' }], hasOlder: false, oldestTurn: null, totalUserTurns: 1 }
        : { messages: [{ id: 'u1', content: 'unchanged dialogue' }], summary: 'unchanged memory', summaryLastTurn: 20 };
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
  } },
});
const uri = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
globalThis.__contextRecoveryClient = client;
const stub = uri('export const supabase = globalThis.__contextRecoveryClient;');
const source = readFileSync(new URL('../src/lib/sessionData.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { generationContext, fetchMessagePage, mutateSummary, selectResponse } = await import(uri(compiled.replace("'./supabase'", `'${stub}'`)));
const session = { id: 'room', summary_last_turn: 20 };
function reset(n = 0, http = 200) { requests.length = 0; failures = n; status = http; controller = undefined; }
try {
  reset(1);
  const before = await client.rpc('session_generation_context', { target_session: session.id });
  assert.match(before.error.message, /TypeError: Load failed/);
  assert.equal(requests.length, 1, 'the pre-fix POST fails immediately without retry');

  reset(1);
  const context = await generationContext(session, 3, false);
  assert.equal(requests.length, 2, 'the actual generation read recovers from one lost connection');
  assert.deepEqual(context, { messages: [{ id: 'u1', content: 'unchanged dialogue' }], summary: 'unchanged memory', summaryLastTurn: 20 });
  assert(requests.every(r => r.method === 'GET' && r.body === undefined));
  assert.equal(requests[0].url.searchParams.get('reroll'), 'false');
  assert.equal(requests[0].url.searchParams.get('keyword_turns'), '3');

  reset(1);
  const page = await fetchMessagePage('room');
  assert.equal(page.totalUserTurns, 1);
  assert.equal(requests.length, 2);
  assert(requests.every(r => !r.url.searchParams.has('before_turn')), 'absent cursor cannot become the string null');
  reset(); await fetchMessagePage('room', 0);
  assert.equal(requests[0].url.searchParams.get('before_turn'), '0', 'preserve a zero cursor');
  reset(); await generationContext(session, 0, true);
  assert.equal(requests[0].url.searchParams.get('reroll'), 'true', 'reroll keeps its full-context semantics');

  reset(20);
  await assert.rejects(generationContext(session, 0, false), e => /Load failed/.test(e.message));
  assert.equal(requests.length, 4, 'permanent outages stop after the SDK limit: initial + three retries');
  for (const http of [403, 404]) {
    reset(0, http);
    await assert.rejects(fetchMessagePage('room'));
    assert.equal(requests.length, 1, 'permission/schema errors are not retried or hidden');
  }
  reset(0, 503);
  await assert.rejects(fetchMessagePage('room'));
  assert.equal(requests.length, 4, 'transient HTTP retries are bounded too');

  reset(1); controller = new AbortController();
  await assert.rejects(generationContext(session, 0, false, controller.signal));
  assert.equal(requests.length, 1, 'cancelling retry backoff prevents another network request');
  reset(); const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(fetchMessagePage('room', undefined, cancelled.signal));
  assert.equal(requests.length, 0, 'cancelled navigation sends no network read');

  for (const mutate of [() => mutateSummary('room', 'delete'), () => selectResponse('room', 'group', 'message')]) {
    reset(1);
    await assert.rejects(mutate());
    assert.equal(requests.length, 1, 'lost write responses must never automatically repeat a mutation');
    assert.equal(requests[0].method, 'POST');
  }
  console.log('Context recovery: reproduced POST failure; real SDK GET recovery, bounded outages, cursor semantics, permission errors, cancellation and non-repeated mutations passed');
} finally { delete globalThis.__contextRecoveryClient; }
