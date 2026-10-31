import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { createServer } from 'vite';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const originalFetch = globalThis.fetch;
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
try {
  const { supabase } = await server.ssrLoadModule('/src/lib/supabase.ts');
  const { loadManualKnowledgeOptions, generateKnowledgeNow } = await server.ssrLoadModule('/src/lib/knowledge/manual.ts');
  const { emptyState } = await server.ssrLoadModule('/src/lib/knowledge/core.ts');
  const { multichatParticipantName } = await server.ssrLoadModule('/src/lib/multichat.ts');
  const { DEFAULT_KNOWLEDGE_CONFIG } = await server.ssrLoadModule('/src/lib/knowledge/types.ts');
  const session = { id: 'room', work_id: 'work', persona_id: 'p', start_config_id: 'start', knowledge_enabled: true, knowledge_revision: 1 };
  const work = { id: 'work', title: 'Work', main_prompt: 'WORLD', multichat_prompt: 'MULTI WORLD' };
  const persona = { id: 'p', name: '누리', description: 'PERSONA' }, start = { initial_context: 'START' };
  const members = [1, 2].map(slot => ({ slot, personas: { name: slot === 1 ? '누리' : '소희', description: 'PERSONA ' + slot } }));
  const context = { enabled: true, revision: 1, cost: 0, inputTokens: 0, outputTokens: 0, entries: [
    { id: 'seed', turn_index: -1, content: '', user_text: '', source_hash: 'seed', setup_hash: '', patch: null },
    { id: 'm1', turn_index: 0, content: 'FIRST SCENE', user_text: '', source_hash: 'h1', setup_hash: '', patch: null },
  ] };
  let failedTable = '', modelCalls = 0, bills = 0;
  supabase.from = table => ({ select() { return this; }, eq() { return this; }, order() { return this; }, abortSignal() { return this; }, single() { return this; },
    then(resolve, reject) { return Promise.resolve({ data: ({ sessions: session, works: work, personas: persona, start_configs: start, multichat_members: members, platform_config: { knowledge_config: DEFAULT_KNOWLEDGE_CONFIG } })[table], error: table === failedTable ? { message: 'LOAD FAILED' } : null }).then(resolve, reject); },
  });
  supabase.rpc = (name, args) => {
    let result;
    if (name === 'knowledge_lease') result = { data: true };
    else if (name === 'knowledge_context') result = { data: structuredClone(context) };
    else if (name === 'record_knowledge_call') { bills++; result = {}; }
    else if (name === 'save_knowledge_event') { const row = context.entries.find(row => row.id === args.target_message); row.patch = args.desired; row.setup_hash = args.setup_hash; result = { data: true }; }
    else throw Error(name);
    const promise = Promise.resolve(result); promise.abortSignal = () => promise; return promise;
  };
  globalThis.window = { location: { origin: 'https://manual.test' } };
  globalThis.fetch = async (url, init) => {
    modelCalls++;
    if (url.endsWith('/decisions')) return new Response(JSON.stringify({ answers: { update: { type: 'noul', noul: 0.95 } }, usage: { cost: 0, input_tokens: 1, output_tokens: 1 } }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(emptyState()) }, finish_reason: 'stop' }], usage: { cost: 0, prompt_tokens: 1, completion_tokens: 1 } }));
  };
  const signal = new AbortController().signal;
  // Compare against the automatic source expressions, not a duplicated expectation.
  function setupExpression(file, property) {
    const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); let result;
    function visit(node) { if (ts.isPropertyAssignment(node) && node.name.getText(ast) === property && node.initializer.getText(ast).startsWith('JSON.stringify')) result = node.initializer.getText(ast); ts.forEachChild(node, visit); }
    visit(ast); assert.ok(result); return result;
  }
  const options = await loadManualKnowledgeOptions('room', 'fixture', signal);
  const automatic = vm.runInNewContext(setupExpression('src/pages/ChatPage.tsx', 'setup'), { work, workCombination: undefined, persona, startConfig: start });
  assert.equal(options.setup, automatic, 'manual and normal automatic checkpoints use identical setup bytes');
  const first = await generateKnowledgeNow('room', 'fixture', signal);
  assert.equal(first.processed, 2); assert.ok(context.entries.every(row => row.patch)); assert.equal(modelCalls, 3);assert.equal(bills, 3);
  const paid = modelCalls;
  assert.equal((await generateKnowledgeNow('room', 'fixture', signal)).processed, 0);assert.equal(modelCalls, paid, 'unchanged manual requests do not repeat paid work');
  context.entries.push({ ...context.entries[1], id: 'm2', turn_index: 1, source_hash: 'h2', setup_hash: '', patch: null });
  assert.equal((await generateKnowledgeNow('room', 'fixture', signal)).processed, 1);assert.equal(modelCalls, paid + 2);
  session.multichat_room_id = 'room';
  const multi = await loadManualKnowledgeOptions('room', 'fixture', signal);
  assert.equal(multi.setup, vm.runInNewContext(setupExpression('src/lib/multichatContext.ts', 'knowledgeSetup'), { work, combination: undefined, members, start, multichatParticipantName }));
  assert.deepEqual(multi.pcs.map(pc => pc.aliases), [['PC1'], ['PC2']]);
  await assert.rejects(() => loadManualKnowledgeOptions('room', '', signal), /API/);
  session.knowledge_enabled = false;await assert.rejects(() => generateKnowledgeNow('room', 'fixture', signal), /켠/);session.knowledge_enabled = true;
  failedTable = 'works';await assert.rejects(() => generateKnowledgeNow('room', 'fixture', signal), error => error.message === 'LOAD FAILED');failedTable = '';
  const abort = new AbortController();abort.abort();await assert.rejects(() => generateKnowledgeNow('room', 'fixture', abort.signal));
  assert.equal(modelCalls, paid + 2, 'invalid/off/cancelled manual jobs do not call a model');

  const values = [], refs = [], effects = [];let index = 0, refIndex = 0, jobs = 0, release, stopped = 0;
  const hooks = { useState(value) { const key = index++;if (!(key in values)) values[key] = value;return [values[key], next => { values[key] = typeof next === 'function' ? next(values[key]) : next; }]; },
    useRef(value) { return refs[refIndex++] ??= { current: value }; }, useMemo: fn => fn(), useEffect: effect => effects.push(effect),
  };
  let confirmDelete = false, clearCalls = 0, cancelled = 0, updated;
  const uiContext = { ...context, entries: [], cost: 0 };
  const Panel = vm.runInNewContext(compile(read('src/components/SessionInformationSettings.tsx').replace(/^import .*$/gm, '').replace('export default function', 'function')) + '\nSessionInformationSettings', {
    ...hooks, jsx: createElement, AbortController, emptyState,
    showConfirmDialog: async () => confirmDelete, cancelKnowledge: () => cancelled++,
    supabase: { rpc: async (name) => { assert.equal(name, 'clear_information_table'); clearCalls++; return { data: { knowledge_enabled: false, knowledge_revision: 2 } }; } }, replayContext: () => ({ state: emptyState(), pending: [] }), Toggle: 'toggle',
    readKnowledgeContext: async () => uiContext, getApiKey: () => 'fixture', registerAccountTask: () => () => stopped++,
    generateKnowledgeNow: async (_id, _key, signal) => { jobs++;return new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError'))); }); },
  });
  let props = { session: { id: 'room', knowledge_enabled: true }, busy: false, onUpdate() {} };
  const render = () => { index = 0;refIndex = 0;return Panel(props); };
  function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]; }
  const button = (tree, text) => nodes(tree).find(node => node.type === 'button' && node.props.children === text);
  let tree = render();const click = button(tree, '지금 생성/갱신').props.onClick;
  click();click();assert.equal(jobs, 1, 'double click starts only one job');
  tree = render();assert.equal(button(tree, '정보 정리 중…').props.disabled, true);
  button(tree, '정보 정리 중단').props.onClick();await tick();tree = render();
  assert.ok(nodes(tree).some(node => typeof node.props?.children === 'string' && node.props.children.includes('정보 정리를 중단')));assert.equal(stopped, 1);
  button(tree, '지금 생성/갱신').props.onClick();release({ processed: 1 });await tick();tree = render();
  assert.ok(nodes(tree).some(node => node.props?.children === '정보표 생성/갱신을 완료했어요.'));
  button(tree, '지금 생성/갱신').props.onClick();release({ processed: 0 });await tick();tree = render();
  assert.ok(nodes(tree).some(node => node.props?.children === '새로 반영할 정보가 없어요. 최신 정보표예요.'));
  props = { ...props, busy: true };assert.equal(button(render(), '지금 생성/갱신').props.disabled, true);
  props = { ...props, busy: false, session: { id: 'room', knowledge_enabled: false } };assert.equal(button(render(), '지금 생성/갱신').props.disabled, true);
  props = { session: { id: 'room', knowledge_enabled: true, knowledge_revision: 1 }, busy: false, onUpdate: patch => updated = patch };
  await button(render(), '정보표 전체 삭제').props.onClick();await tick();
  assert.equal(clearCalls, 0, 'cancelled confirmation never clears');
  confirmDelete = true;
  button(render(), '정보표 전체 삭제').props.onClick();button(render(), '정보표 전체 삭제').props.onClick();await tick();
  assert.equal(clearCalls, 1, 'duplicate clicks clear once');assert.equal(cancelled, 1);
  assert.equal(updated.knowledge_enabled, false);assert.equal(updated.knowledge_revision, 2);
  assert.ok(nodes(render()).some(node => node.props?.children === '정보표를 전체 삭제하고 정보 접근 관리를 껐어요.'));
  console.log('Manual information: zero-turn bootstrap, incremental paid calls, identical automatic setup, both PC mappings, OFF/key/load/cancel guards, UI duplicate lock, stop, success and no-change status passed.');
} finally { globalThis.fetch = originalFetch;delete globalThis.window;await server.close(); }
