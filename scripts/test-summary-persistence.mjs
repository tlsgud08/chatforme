import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/lib/summaryPersistence.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { saveSummaryWithFallback } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const calls = [];
let mode = 'current';
const client = createClient('https://summary-save.test', 'mock-key', {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: async (_url, request) => {
    const args = JSON.parse(request.body); calls.push(args);
    if (mode === 'network') throw new TypeError('Load failed');
    const code = mode === 'old' && 'generation_narrative_config' in args ? 'PGRST202' : mode === 'missing' ? 'PGRST202' : mode === 'denied' ? '42501' : mode === 'conflict' ? '40001' : mode === 'ambiguous' ? 'PGRST203' : null;
    return new Response(JSON.stringify(code ? { code, message: 'fixture error' } : { id: args.target_session ?? args.target_room, summary: args.summary_text }), {
      status: code ? code === 'PGRST202' ? 404 : code === '42501' ? 403 : 409 : 200,
      headers: { 'content-type': 'application/json' },
    });
  } },
});
for (const name of ['save_generated_summary', 'finish_multichat_summary']) {
  const args = { [name === 'save_generated_summary' ? 'target_session' : 'target_room']: 'room', summary_text: '정상 또는 중지된 본문', through_turn: 109,
    source_versions: [{ id: 'source', version: 7 }], previous_summary: 'previous', in_tokens: 100, out_tokens: 50, response_cost: 0.012,
    generation_finish_reason: 'user_stop', generation_native_finish_reason: 'client_abort',
    generation_narrative_config: { unit: 'characters', target: '10000', enabled: true },
    ...(name === 'finish_multichat_summary' ? { request_id: 'request', token: 'claim' } : { previous_summary_turn: 99 }),
  };
  for (const scenario of ['current', 'old', 'missing', 'denied', 'conflict', 'ambiguous', 'network']) {
    mode = scenario; calls.length = 0;
    const result = await saveSummaryWithFallback(value => client.rpc(name, value), args);
    assert.equal(calls.length, ['old', 'missing'].includes(mode) ? 2 : 1, 'only an absent overload permits one compatibility write');
    assert.deepEqual(calls[0], args);
    if (calls.length === 2) {
      const { generation_narrative_config: _goal, ...expected } = args;
      assert.deepEqual(calls[1], expected, 'all body, usage, source, completion and ownership/claim arguments survive');
    }
    if (['current', 'old'].includes(mode)) { assert.equal(result.error, null); assert.equal(result.data.summary, args.summary_text); }
    else assert(result.error, 'real write failures stay visible and do not repeat a possibly committed write');
    assert('generation_narrative_config' in args, 'fallback never mutates the retained request');
  }
}
console.log('Summary persistence: reproduced missing-overload 404 through the real SDK, current/legacy ordinary and multi signatures, exact source/claim/usage preservation and no write retry on outages, denial or conflicts passed.');

// Use the actual page handlers: editing a failed draft changes the retained save
// payload, and retrying saves that payload without invoking the model again.
const page = ts.createSourceFile('chat.tsx', readFileSync(new URL('../src/pages/ChatPage.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = [];
function visit(node) { if (ts.isFunctionDeclaration(node) && ['changeSummaryDraft', 'retrySummarySave'].includes(node.name?.text)) handlers.push(node.getText(page)); ts.forEachChild(node, visit); }
visit(page); assert.equal(handlers.length, 2);
const compiledHandlers = ts.transpileModule(handlers.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
for (const denied of [false, true]) {
  const request = { target_session: 'room', summary_text: 'original', previous_summary: 'previous', through_turn: 109, source_versions: [{ id: 'source', version: 7 }] };
  const retained = { current: request }, received = [], saved = [], errors = [];
  const actions = vm.runInNewContext(compiledHandlers + '\n({changeSummaryDraft,retrySummarySave})', {
    summaryContent: 'original', summaryGenerating: false, summarySaveRequestRef: retained, saveSummaryWithFallback,
    setSummaryContent: text => received.push(text), setSummaryGenerating() {}, setSummarySaving() {}, setSession() {},
    loadLatestMessages: async () => {}, showToast() {}, describeUnknownError: error => error.message, addError: error => errors.push(error),
    supabase: { rpc: async (_name, args) => { saved.push(args); return denied ? { error: { code: '42501', message: 'denied' } } : { data: { id: 'room' } }; } },
  });
  actions.changeSummaryDraft('edited received body');
  await actions.retrySummarySave();
  assert.equal(saved.length, 1); assert.equal(saved[0].summary_text, 'edited received body');
  assert.equal(JSON.stringify(saved[0].source_versions), JSON.stringify(request.source_versions));
  if (denied) { assert(retained.current); assert.equal(received.at(-1), 'edited received body'); assert.equal(errors.length, 1); }
  else { assert.equal(retained.current, null); assert.equal(received.at(-1), ''); }
  actions.changeSummaryDraft(''); assert.equal(retained.current, null, 'discard removes the local pending write');
}
console.log('Summary save recovery: actual edit/discard/retry handlers preserve the received body and source checks, clear only after acknowledgement and never regenerate.');
