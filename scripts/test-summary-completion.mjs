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
  const { summaryPromptWithParameters } = await server.ssrLoadModule('/src/lib/summaryPrompt.ts');
  const page = ts.createSourceFile('chat.tsx', readFileSync(new URL('../src/pages/ChatPage.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'generateSummary') handler = node.getText(page);
    ts.forEachChild(node, visit);
  }
  visit(page); assert.ok(handler);
  const compiled = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let finishReason = 'stop', content = '받은 요약 원문', saveFailure = false, sent = [];
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ choices: [{ finish_reason: finishReason, native_finish_reason: 'NATIVE_' + finishReason,
      message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 9000, cost: 0.01 } });
  };
  const saved = [], warnings = [], operations = [];
  const session = { id: 'room', summary: '', summary_last_turn: 0, summary_source_mode_override: 'full' };
  const messages = [{ id: 'u', role: 'user', content: '행동', is_active_variant: true }, { id: 'a', role: 'assistant', content: '장면', is_active_variant: true }];
  const summaryTasks = new Map();
  const run = vm.runInNewContext(compiled + '\ngenerateSummary', {
    contextReady: true, session, profile: {}, AbortController,
    editInFlightRef: { current: false }, deleteInFlightRef: { current: false }, branchInFlightRef: { current: false },
    sendInFlightRef: { current: false }, workCombinationSavingRef: { current: false },
    activeGenerations: new Map(), activeSummaryGenerations: summaryTasks, summaryGenerating: false,
    getApiKey: () => 'fixture', registerAccountTask: () => () => {}, setSummaryGenerating() {}, finishSummaryGeneration: id => summaryTasks.delete(id),
    readLiveThemeContext: async () => ({}), recoverExpiredResponses: async () => {},
    fetchAllSessionMessages: async () => messages, messagesThroughTurn: rows => rows, messagesAfterSummary: rows => rows,
    automaticThemeEnabled: () => false, stripThemeDirectives: text => text,
    loadGlobalSummaryPrompt: async () => 'GLOBAL', loadSemiSyncSummaryPrompt: async () => 'SYNC', summaryPromptWithParameters,
    modelsFor: () => ['fixture/model'], normalizeReasoning: () => ({ send: false }),
    loadSemiContext: async () => null, withoutSyncDateTags: value => value,
    generate, summaryResultMetadata, summaryCompletionWarning,
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
      finishReason = reason; sent = []; saved.length = 0; warnings.length = 0; operations.length = 0;
      const result = await run(kind === 'merge' ? [{ id: 'note', content: '기존 요약', summarized_through_turn: 1 }] : [], 1, kind === 'sync' ? 'link' : undefined);
      assert.equal(result, true, JSON.stringify({kind,reason,warnings})); assert.equal(sent.length, 1, 'no automatic paid retry');
      assert.ok(!('max_tokens' in sent[0]), 'summary HTTP request omits output cap');
      assert.equal(saved[0].args.summary_text ?? saved[0].args.content, content, 'partial body saved verbatim');
      assert.equal(saved[0].args.generation_finish_reason, reason ?? 'unknown');
      assert.equal(saved[0].args.generation_native_finish_reason, 'NATIVE_' + reason);
      assert.equal(warnings.length, reason === 'stop' ? 0 : 1);
      if (reason === 'length') assert.match(warnings[0], /제공자 출력 제한.*저장/);
      if (kind === 'sync') assert.deepEqual(operations, ['prepare', 'publish']);
    }
  }
  content = ''; saved.length = 0; warnings.length = 0;
  assert.equal(await run(), false); assert.equal(saved.length, 0); assert.match(warnings[0], /빈 응답/);
  content = '잘린 본문'; finishReason = 'length'; saveFailure = true; saved.length = 0; warnings.length = 0;
  assert.equal(await run(), false); assert.equal(saved.length, 0); assert.ok(!warnings[0].includes('저장했어요'), 'failed DB write never claims saved');
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
