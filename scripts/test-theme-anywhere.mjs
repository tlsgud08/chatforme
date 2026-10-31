import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { createServer } from 'vite';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const compile = code => ts.transpileModule(code, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: 'jsx',
} }).outputText;
function findSource(file, predicate) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let result;
  function visit(node) { if (predicate(node)) result = node.getText(source); ts.forEachChild(node, visit); }
  visit(source); assert.ok(result, file); return result;
}
const effect = findSource('src/pages/ChatPage.tsx', node => ts.isArrowFunction(node) && node.body.getText().includes('observeThemeDirective(themeMessageRef.current'));
const generation = findSource('src/pages/MultichatPage.tsx', node => ts.isFunctionDeclaration(node) && node.name?.text === 'runGeneration');
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const tick = () => new Promise(resolve => setImmediate(resolve));
try {
  const h = await server.ssrLoadModule('/src/lib/themeDirectives.ts');
  const { DEFAULT_DARK, DEFAULT_LIGHT, paletteFor } = await server.ssrLoadModule('/src/lib/theme.ts');
  const { workThemeScopeKey } = await server.ssrLoadModule('/src/lib/workCombination.ts');
  const { emptyState } = await server.ssrLoadModule('/src/lib/knowledge/core.ts');
  const themes = ['정원', '실내'].map((name, index) => ({ id: String(index), name, work_id: 'work', dark_colors: DEFAULT_DARK, light_colors: DEFAULT_LIGHT }));
  const cases = [
    ['{{theme::정원}} 뒤 본문', '0'],
    ['앞 본문 {{theme::실내}} 뒤 본문', '1'],
    ['본문 {{theme::정원}}', '0'],
    ['{{theme::정원}} 본문 {{theme::실내}} 후속 본문', '1'],
    ['{{theme::정원}} 본문 {{theme::없는테마}} 후속 본문', '0'],
    ['{{theme::정원}} {{theme::keep}} 뒤 본문', null],
    ['{{theme::keep}} {{theme::실내}} 뒤 본문', '1'],
    ['본문 {{theme::없는테마}} 뒤 본문', null],
    ['본문 {{theme::정원', null],
  ];
  let checked = 0;
  for (const legacy of [undefined, false, true]) for (const [content, expected] of cases) {
    const session = { id: 'room', user_id: 'owner', work_id: 'work', theme_variant: 'light', theme_override: null,
      knowledge_enabled: false, ...(legacy === undefined ? {} : { theme_anywhere_enabled: legacy }) };
    const writes = [], errors = [], committed = [];
    const supabase = { from: () => ({ update(patch) { writes.push(patch); return this; }, eq() { return this; }, is() { return this; }, select() { return this; },
      maybeSingle: async () => ({ data: { id: 'room' }, error: null }), then(resolve, reject) { return Promise.resolve({ error: null }).then(resolve, reject); } }),
      rpc: async () => ({ data: { messageId: 'reply', token: 'token', round: 1 } }),
    };
    const latest = { id: 'reply', role: 'assistant', content, generation_status: 'complete' };
    const refs = { themeMessageRef: { current: h.observeThemeDirective(null, 'room', null).observation }, themeRequestScopeRef: { current: null } };
    let displayed = session;
    const runEffect = vm.runInNewContext(compile('const apply = ' + effect) + '\napply', {
      session, messages: [latest], ...refs, ...h, workThemeScopeKey, paletteFor, supabase,
      readLiveThemeContext: async () => ({ session, themes, dayNight: false, variant: 'light' }),
      setSession: update => { displayed = update(displayed); }, requestThemeRefresh() {}, addError: error => errors.push(error), describeUnknownError: error => error.message,
    });
    runEffect(); await tick();
    assert.deepEqual(errors, []); assert.equal(writes.length, expected === null ? 0 : 1);
    if (expected !== null) { assert.equal(writes[0].theme_id, expected); assert.equal(displayed.theme_id, expected); }
    const count = writes.length;
    runEffect(); await tick();assert.equal(writes.length, count, 'unchanged response/manual choice never replays');
    for (const status of ['streaming', 'interrupted']) {
      latest.id = status; latest.generation_status = status;
      runEffect(); await tick();assert.equal(writes.length, count, status + ' is not applied');
    }
    latest.generation_status = 'complete'; latest.id = 'fixed'; session.theme_override = 'custom';
    runEffect(); await tick();assert.equal(writes.length, count, 'fixed theme remains fixed');
    session.theme_override = null;
    writes.length = 0;
    const prepared = { session, auto: true, assembled: { systemParts: {}, messages: [] }, catalog: { themes }, dayNight: false };
    const runGeneration = vm.runInNewContext(compile(generation) + '\nrunGeneration', {
      data: { profile: {}, session, room: { id: 'room' }, members: [] }, me: { slot: 2 }, user: null,
      lock: { current: false }, summaryLock: { current: false }, pending: null, controller: { current: null },
      getApiKey: () => 'fixture', setGenerating() {}, AbortController, setTimeout, clearTimeout, registerAccountTask: () => () => {},
      prepareMultichatContext: async () => prepared, createDraftWriter: () => ({ stop: async () => {} }), refresh: async () => {},
      generate: async () => ({ text: content, usage: { inputTokens: 1, outputTokens: 1, cost: 0 } }),
      multichatNarrative: text => text, setDiagnostics() {}, setPending() {}, commit: async value => committed.push(value),
      ...h, paletteFor, supabase, requestThemeRefresh() {}, report: error => errors.push(error), errorText: error => error.message,
    });
    await runGeneration(); assert.deepEqual(errors, []);assert.equal(committed[0].response_text, content, 'raw stored tags remain intact');
    assert.equal(writes.length, expected === null ? 0 : 1);
    if (expected !== null) assert.equal(writes[0].theme_id, expected);
    checked += 2;
  }
  // Render the real information settings JSX: only the independent knowledge switch remains.
  const rpc = [], updates = [];
  const source = read('src/components/SessionInformationSettings.tsx').replace(/^import .*$/gm, '').replace('export default function', 'function');
  const Panel = vm.runInNewContext(compile(source) + '\nSessionInformationSettings', { jsx: createElement,
    useState: value => [value, () => {}], useEffect() {}, useMemo: fn => fn(), useRef: value => ({ current: value }),
    emptyState, Toggle: 'toggle',
    supabase: { rpc: async (name, args) => { rpc.push({ name, args }); return { data: { knowledge_enabled: args.knowledge, knowledge_revision: 1 } }; } },
  });
  const tree = Panel({ session: { id: 'room', theme_anywhere_enabled: false }, busy: false, onUpdate: update => updates.push(update) });
  function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]; }
  const toggles = nodes(tree).filter(node => node.type === 'toggle');
  assert.equal(toggles.length, 1);assert.equal(toggles[0].props['aria-label'], '정보 접근 관리');
  toggles[0].props.onChange(true);await tick();
  assert.equal(rpc[0].args.knowledge, true);assert.equal(rpc[0].args.theme_anywhere, true);assert.equal(updates.length, 1);
  console.log(`Always-on theme tags: ${checked} real chat/multichat paths passed (beginning/middle/end, legacy absent/OFF/ON, last valid, keep, malformed tags, fixed themes, incomplete replies, no replay, raw storage and removed toggle).`);
} finally { await server.close(); }
