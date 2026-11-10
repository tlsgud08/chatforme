import { providerFixture } from './provider-fixture.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const originalFetch = globalThis.fetch;
globalThis.window = { location: { origin: 'https://summary.test' } };
try {
  const { generate } = await server.ssrLoadModule('/src/lib/llm/index.ts');
  const { readOpenAIStream } = await server.ssrLoadModule('/src/lib/llm/stream.ts');
  const { summaryCompletionWarning, summaryResultMetadata } = await server.ssrLoadModule('/src/lib/summaryCompletion.ts');
  const { saveSummaryWithFallback } = await server.ssrLoadModule('/src/lib/summaryPersistence.ts');
  const { generateSummaryResponse, isUserSummaryStop, SUMMARY_USER_STOP } = await server.ssrLoadModule('/src/lib/summaryGeneration.ts');
  const { summaryNarrativeConfig, summaryAchievementToast } = await server.ssrLoadModule('/src/lib/summaryNarrative.ts');
  const { summaryPromptWithParameters } = await server.ssrLoadModule('/src/lib/summaryPrompt.ts');
  const page = ts.createSourceFile('chat.tsx', readFileSync(new URL('../src/pages/ChatPage.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler; const sourceFunctions = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && ['messagesThroughTurn', 'messagesAfterSummary'].includes(node.name?.text)) sourceFunctions.push(node.getText(page));
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'generateSummary') handler = node.getText(page);
    ts.forEachChild(node, visit);
  }
  visit(page); assert.ok(handler);
  const compiled = ts.transpileModule(sourceFunctions.join('\n') + '\n' + handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let stopMode = 'none'; const previews = [];
  let finishReason = 'stop', content = '받은 요약 원문', saveFailure = false, sent = [];
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return new Response('data: ' + JSON.stringify({ choices: [{ finish_reason: finishReason, native_finish_reason: 'NATIVE_' + finishReason, delta: { content } }], usage: { prompt_tokens: 1, completion_tokens: 9000, cost: 0.01 } }) + '\n\ndata: [DONE]\n\n');
  };
  const saved = [], warnings = [], operations = [], toasts = [];
  const session = { id: 'room', summary: 'OLD ARCHIVE MUST NOT REPLACE THE SOURCE', summary_last_turn: 0 }; // No source setting: full is the default.
  const messages = [{ id: 'h', role: 'assistant', is_hidden: true, content: 'HIDDEN START' }, { id: 'u', role: 'user', content: 'TURN ONE' }, { id: 'a', role: 'assistant', content: 'REPLY ONE' }, { id: 'old', role: 'assistant', content: 'INACTIVE REROLL', is_active_variant: false }, { id: 'u2', role: 'user', content: 'TURN TWO' }, { id: 'a2', role: 'assistant', content: 'REPLY TWO' }];
  const summaryTasks = new Map();
  const run = vm.runInNewContext(compiled + '\ngenerateSummary', {
    contextReady: true, session, profile: {}, AbortController, saveSummaryWithFallback, summarySaveRequestRef: { current: null },
    editInFlightRef: { current: false }, deleteInFlightRef: { current: false }, branchInFlightRef: { current: false },
    sendInFlightRef: { current: false }, workCombinationSavingRef: { current: false },
    activeGenerations: new Map(), activeSummaryGenerations: summaryTasks, summaryGenerating: false,
    ...providerFixture, getApiKey: () => 'fixture', registerAccountTask: () => () => {}, setSummaryGenerating() {}, finishSummaryGeneration: id => summaryTasks.delete(id),
    readLiveThemeContext: async () => ({}), recoverExpiredResponses: async () => {},
    fetchAllSessionMessages: async () => messages,
    automaticThemeEnabled: () => false, stripThemeDirectives: text => text,
    loadGlobalSummaryPrompt: async () => { if (stopMode === 'before') summaryTasks.get(session.id).controller.abort(SUMMARY_USER_STOP); return 'GLOBAL'; }, loadSemiSyncSummaryPrompt: async () => 'SYNC', summaryPromptWithParameters,
    modelsFor: () => ['fixture/model'], normalizeReasoning: () => ({ send: false }),
    loadSemiContext: async () => null, withoutSyncDateTags: value => value,
    setSummarySaving() {}, setSummaryContent(text) { previews.push(text); if (text && (stopMode === 'during' || stopMode === 'account')) { const task = summaryTasks.get(session.id); if (!task.controller.signal.aborted) task.controller.abort(stopMode === 'during' ? SUMMARY_USER_STOP : 'account reset'); } }, publishSummaryContent() {}, markSummarySaving() {}, generateSummaryResponse, isUserSummaryStop, SUMMARY_USER_STOP,
    generate, summaryResultMetadata, summaryCompletionWarning, summaryNarrativeConfig, summaryAchievementToast,
    showToast: (...args) => { if (args[0].includes('내용 저장') || args[0].includes('저장 완료')) assert(saved.length > 0, 'saved toast follows the acknowledged save'); toasts.push(args); },
    setMessages() {}, setSession() {}, addError: message => warnings.push(message), describeUnknownError: error => error.message,
    supabase: { rpc: async (name, args) => { if (saveFailure) return { error: Error('保存失敗') }; saved.push({ name, args }); return { data: session }; } },
    semiAction: async (op, _session, _link, args) => {
      operations.push(op);
      if (op === 'prepare') return { token: 'ticket', session };
      if (op === 'publish') { if (saveFailure) throw Error('保存失敗'); saved.push({ name: 'publish', args }); }
      return {};
    },
  });
  for (const kind of ['ordinary', 'merge', 'sync']) {
    for (const reason of ['stop', 'length', 'content_filter', 'error', null]) {
      finishReason = reason; sent = []; saved.length = 0; warnings.length = 0; operations.length = 0; toasts.length = 0;
      const result = await run(kind === 'merge' ? [{ id: 'note', content: '기존 요약', summarized_through_turn: 1 }] : [], 1, kind === 'sync' ? 'link' : undefined);
      assert.equal(result, true, JSON.stringify({kind,reason,warnings})); assert.equal(sent.length, 1, 'no automatic paid retry');
      assert.ok(!('max_tokens' in sent[0]), 'summary HTTP request omits output cap');
      assert.equal(saved[0].args.summary_text ?? saved[0].args.content, content, 'partial body saved verbatim');
      assert.equal(saved[0].args.generation_finish_reason, reason ?? 'unknown');
      assert.equal(saved[0].args.generation_native_finish_reason, 'NATIVE_' + reason);
      assert.equal(warnings.length, reason === 'stop' ? 0 : 1);
      if (reason === 'length') assert.match(warnings[0], /제공자 출력 제한.*저장/);
      assert.equal(toasts.length, kind === 'sync' ? 0 : 1, 'ordinary/merged notes report once; separate sync prompt has no target');
      if (kind === 'ordinary') { const input = sent[0].messages.at(-1).content; assert(input.includes('HIDDEN START') && input.includes('TURN ONE') && input.includes('REPLY ONE')); assert(!input.includes('TURN TWO') && !input.includes('INACTIVE REROLL') && !input.includes(session.summary), 'full input obeys through-turn, active-variant filtering and excludes the old archive'); }
      if (kind === 'sync') assert.deepEqual(operations, ['prepare', 'publish']);
    }
  }
  content = '[핵심 서사 및 맥락]\n중지 직전의 본문';finishReason = 'stop';stopMode = 'during';
  saved.length = 0;sent = [];warnings.length = 0;previews.length = 0;
  assert.equal(await run([], 1), true);assert.equal(sent.length, 1);
  assert.equal(saved[0].args.summary_text, content);assert.equal(saved[0].args.generation_finish_reason,'user_stop');
  assert.equal(saved[0].args.in_tokens,1);assert.equal(saved[0].args.out_tokens,9000);assert.equal(saved[0].args.response_cost,0.01);
  assert(previews.includes(content));assert.equal(previews.at(-1),'','successful save removes the temporary preview');
  saveFailure = true;previews.length = 0;saved.length = 0;toasts.length = 0;
  assert.equal(await run([], 1),false);assert.equal(saved.length,0);assert.equal(previews.at(-1),content,'a rejected save leaves the received text on screen');
  assert.equal(toasts.length,0);saveFailure=false;
  for (const mode of ['before','account']) {
    stopMode=mode;saved.length=0;sent=[];toasts.length=0;
    assert.equal(await run([],1),false);assert.equal(saved.length,0,'empty/cross-account cancellation never overwrites the existing note');
    if(mode==='before') assert.equal(sent.length,0);
  }
  stopMode='none';
  session.summary_narrative_target_chars_override = '20000';
  content = '[핵심 서사 및 맥락]\n' + 'x'.repeat(12480) + '\n[주요 갈등]\nignored'; finishReason = 'stop'; toasts.length = 0;
  assert.equal(await run([], 1), true); assert.match(toasts[0][0], /62% \(12,480 \/ 20,000자\)/);
  toasts.length = 0;
  content = ''; saved.length = 0; warnings.length = 0;
  assert.equal(await run(), false); assert.equal(saved.length, 0); assert.match(warnings[0], /빈 응답/);
  content = '잘린 본문'; finishReason = 'length'; saveFailure = true; saved.length = 0; warnings.length = 0;
  assert.equal(await run(), false); assert.equal(saved.length, 0); assert.ok(!warnings[0].includes('저장했어요'), 'failed DB write never claims saved');
  assert.equal(toasts.length, 0, 'empty output and rejected saves never report achievement');
  saveFailure = false;
  for (const reason of ['stop', 'length', 'content_filter']) {
    const stream = new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: reason, native_finish_reason: 'NATIVE' }] })}\n\ndata: [DONE]\n\n`);
    const parsed = await readOpenAIStream(stream.body, () => {});
    assert.equal(parsed.finishReason, reason); assert.equal(parsed.nativeFinishReason, 'NATIVE'); assert.equal(parsed.text, content);
  }
  assert.equal(summaryCompletionWarning(null), null, 'legacy notes stay unclassified');
  console.log('Summary completion: real HTTP serialization, ordinary/merge/sync handlers, partial-body preservation, warnings, empty/save failure, no paid retries and streaming reasons passed.');
} finally {
  globalThis.fetch = originalFetch; delete globalThis.window; await server.close();
}
