import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createServer } from 'vite';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const source = ts.createSourceFile('ChatPage.tsx', read('src/pages/ChatPage.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let sendSource;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'send') sendSource = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert(sendSource);

// Run the real send handler and prompt assembly through the real OpenRouter
// adapter, with recorded HTTP bodies and persistence boundaries; no paid calls.
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const originalFetch = globalThis.fetch;
const bodies = [], storage = new Map();
globalThis.window = { location: { origin: 'https://reroll.test' } };
globalThis.sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
let failure = '', activeSignal;
globalThis.fetch = async (_url, options) => {
  bodies.push(JSON.parse(options.body));
  if (failure === 'model') throw new TypeError('fixture network failure');
  if (failure === 'abort') { activeSignal.abort(); throw new DOMException('fixture abort', 'AbortError'); }
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'NEW ANSWER' } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 } }) + '\n\ndata: [DONE]\n\n');
};
try {
  const { generate } = await server.ssrLoadModule('/src/lib/llm/index.ts');
  const { assemblePrompt } = await server.ssrLoadModule('/src/lib/prompt/assemble.ts');
  const { applySemiContext } = await server.ssrLoadModule('/src/lib/semiSession.ts');
  const { withoutSyncDateTags } = await server.ssrLoadModule('/src/lib/syncDate.ts');
  const { resolvePromptCache } = await server.ssrLoadModule('/src/lib/llm/promptCache.ts');
  const message = (id, role, content, turn_index) => Object.freeze({ id, role, content, turn_index, is_hidden: false, is_active_variant: true, generation_status: 'complete', reroll_index: 1 });
  const history = Object.freeze([message('user1', 'user', 'earlier input', 1), message('ai1', 'assistant', 'earlier answer', 1),
    Object.freeze({ ...message('user2', 'user', 'original input', 2), command_name: 'scene', command_prompt: 'original command' }),
    message('ai2', 'assistant', 'original answer', 2)]);
  const saved = [], errors = [], keywords = [];
  const session = { id: 'room', user_id: 'owner', summary: '', summary_last_turn: 0, user_note: 'persistent note', active_plugins: [], theme_override: 'dark' };
  const registry = new Map();
  let semiContext = null;
  const env = {
    AbortController, DOMException, crypto, performance, setTimeout, clearTimeout,
    GENERATION_TIMEOUT_MS: 60_000, DRAFT_SAVE_INTERVAL_MS: 1000,
    pendingSave: null, user: { id: 'owner' }, sessionId: 'room', session, work: { id: 'work', main_prompt: 'main prompt' },
    profile: { default_output_tokens: 256 }, sessionModel: 'test/model', sessionReasoning: { send: false },
    contextReady: true, messages: history, input: 'new composer draft', selectedCommand: null, keywordBooks: [], storyNotes: [], persona: null,
    systemPrompt: 'system prompt', themePrompt: '', queryClient: { invalidateQueries: async () => {} },
    pendingResponse: () => null, showToast: text => errors.push(text), addError: text => errors.push(text),
    editInFlightRef: { current: false }, deleteInFlightRef: { current: false }, branchInFlightRef: { current: false },
    workCombinationSavingRef: { current: false }, sendInFlightRef: { current: false }, abortControllerRef: { current: null },
    themeRequestScopeRef: { current: null }, activeGenerations: registry, activeSummaryGenerations: new Map(),
    modelsFor: () => ['test/model'], getApiKey: () => 'fixture-key', PROVIDER_LABELS: { openrouter: 'OpenRouter' },
    registerAccountTask: controller => { activeSignal = controller; return () => {}; },
    startOperation: () => ({ mark() {}, finish() {}, describe: () => '' }),
    setInput() {}, setSelectedCommand() {}, setSending() {}, setStreamingContent() {}, setMessages() {}, setTotalUserTurnCount() {},
    setCacheDiagnostics() {}, setSession() {}, setPendingSave() {}, cacheSessionCount() {},
    publishGeneration: (id, content) => { if (content === null) registry.delete(id); },
    readLiveThemeContext: async () => ({ session, themes: [], names: [], scope: null, dayNight: false }),
    loadWorkCombination: async () => null, loadSemiContext: async () => semiContext,
    generationContext: async () => { if (failure === 'context') throw Error('fixture context failure'); return { messages: history, summary: '', summaryLastTurn: 0, contextHash: 'context' }; },
    buildHistory: messages => messages,
    getActiveKeywordContents: (_messages, input) => { keywords.push(input); return []; },
    automaticThemeEnabled: () => false, themeCatalogPrompt: () => '', workThemeScopeKey: () => 'work',
    assemblePrompt, applySemiContext, withoutSyncDateTags, resolvePromptCache, generate,
    createDraftWriter: () => ({ push() {}, stop: async () => {} }),
    beginResponse: async args => { saved.push(['begin', structuredClone(args)]); return { draft: { id: 'draft', generation_status: 'streaming' } }; },
    retainResponse: (_owner, args) => { saved.push(['retain', structuredClone(args)]); return true; },
    commitResponse: async args => { saved.push(['commit', structuredClone(args)]); if (failure === 'save') throw Error('fixture save failure'); return { message: { id: 'draft' }, session }; },
    forgetResponse: (_owner, args) => saved.push(['forget', structuredClone(args)]), applyCommittedResponse() {},
    describeUnknownError: error => error.message,
  };
  const send = vm.runInNewContext(compile(sendSource) + '\nsend', env);
  const legacy = 'original input\n\n[Selected Command /scene]\noriginal command';
  await send({ reroll: true });
  const baseline = structuredClone(bodies.at(-1));
  assert.equal(baseline.messages.at(-1).content, legacy);
  for (const rerollDirection of ['', '  \n\t']) {
    await send({ reroll: true, rerollDirection });
    assert.deepEqual(bodies.at(-1), baseline, 'empty instructions preserve the entire serialized model payload');
  }
  for (const scenario of ['', 'model', 'abort', 'context', 'save']) {
    failure = scenario;
    const before = bodies.length, text = 'UNIQUE DIRECTION ' + (scenario || 'success');
    await send({ reroll: true, rerollDirection: '  ' + text + '  ' });
    if (scenario === 'context') assert.equal(bodies.length, before);
    else {
      const wire = bodies.at(-1);
      assert.equal(JSON.stringify(wire).split(text).length - 1, 1);
      assert.equal(wire.messages.at(-1).role, 'user');
      assert(wire.messages.at(-1).content.startsWith(legacy));
      assert(wire.messages.at(-1).content.endsWith(text));
      assert.deepEqual(wire.messages.slice(0, -1), baseline.messages.slice(0, -1));
    }
    assert(!JSON.stringify(saved).includes(text), 'no instruction in start/commit/recovery payloads');
    assert(!JSON.stringify(history).includes(text), 'original turns stay immutable');
    assert(!JSON.stringify(keywords).includes(text), 'directions do not activate persistent keyword state');
    assert(!JSON.stringify([...storage]).includes(text), 'diagnostics do not store instruction text');
    assert.equal(registry.size, 0); assert.equal(env.sendInFlightRef.current, false);
    failure = '';
    await send({ reroll: true });
    assert.deepEqual(bodies.at(-1), baseline, 'a subsequent reroll never inherits a direction');
    await send({ rerollDirection: text });
    assert(!JSON.stringify(bodies.at(-1)).includes(text), 'normal sends ignore reroll-only input');
  }
  assert.equal(saved.find(([type]) => type === 'begin')[1].requested_turn, 2);
  assert.equal(saved.find(([type]) => type === 'begin')[1].requested_variant, 2);
  assert.equal(saved.find(([type]) => type === 'begin')[1].user_message_id, null);
  semiContext = { prompt: 'peer rules', peer_persona: { name: 'Peer', description: 'peer persona' }, peer: null };
  await send({ reroll: true, rerollDirection: 'SEMI DIRECTION' });
  assert(bodies.at(-1).messages[0].content.includes('peer rules'));
  assert(bodies.at(-1).messages.at(-1).content.endsWith('SEMI DIRECTION'));
  console.log('Reroll requests: identical blank payload, original commands/variants, request-only direction, unchanged history/system, normal-send isolation, failure/abort/save/context cleanup and peer context passed');
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.window; delete globalThis.sessionStorage;
  await server.close();
}

// Exercise the actual dialog's handlers without a browser or a new test dependency.
const hooks = uri(`
export const useEffect=effect=>globalThis.__rerollEffects.push(effect);
export const useRef=value=>({current:value});
export const useState=value=>[value,()=>{}];`);
globalThis.__rerollEffects = [];
const Dialog = (await import(uri(compile(read('src/components/RerollDialog.tsx'))
  .replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier) =>
    'from ' + JSON.stringify(specifier === 'react' ? hooks : import.meta.resolve(specifier)))))).default;
const find = (node, type) => {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const result = find(child, type); if (result) return result; }
  return null;
};
const submissions = [], noop = () => {}, event = { preventDefault: noop };
let cancelled = 0;
const render = (disabled = false) => Dialog({ disabled, onCancel: () => cancelled++, onSubmit: direction => submissions.push(direction) });
let tree = render(), form = find(tree, 'form'), input = find(tree, 'textarea');
input.ref.current = { value: '  desired direction  ' };
form.props.onSubmit(event); form.props.onSubmit(event);
assert.deepEqual(submissions, ['desired direction']); assert.equal(input.ref.current.value, '');
tree = render(); form = find(tree, 'form'); input = find(tree, 'textarea');
assert.equal(input.ref.current, null, 'a remounted dialog starts empty');
input.ref.current = { value: ' \n\t ' }; form.props.onSubmit(event);
assert.equal(submissions.at(-1), '');
tree = render(true); form = find(tree, 'form'); input = find(tree, 'textarea');
input.ref.current = { value: 'blocked' }; form.props.onSubmit(event); assert.equal(submissions.length, 2);
find(tree, 'button').props.onClick(); assert.equal(cancelled, 1);
form.props.onKeyDown({ key: 'Escape', preventDefault: noop, stopPropagation: noop }); assert.equal(cancelled, 2);
tree.props.onMouseDown({ target: 'backdrop', currentTarget: 'backdrop' }); assert.equal(cancelled, 3);
tree.props.onMouseDown({ target: 'input', currentTarget: 'backdrop' }); assert.equal(cancelled, 3);
const previous = { isConnected: true, focus: () => {} };
globalThis.HTMLElement = class { static [Symbol.hasInstance](value) { return value === previous; } };
globalThis.document = { activeElement: previous };
input.ref.current = { value: 'discard on unmount', focus: noop };
const cleanup = globalThis.__rerollEffects.at(-1)(); cleanup();
assert.equal(input.ref.current.value, '');
delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.__rerollEffects;
console.log('Reroll dialog: trimmed/blank input, duplicate-submit guard, disabled state, cancel/Escape/backdrop, remount reset and unmount disposal passed');
