import { providerFixture } from './provider-fixture.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement, Fragment } from 'react';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'jsx', jsxFragmentFactory: 'Fragment' } }).outputText;
const source = read('src/components/SessionMenu.tsx').replace(/^import .*$/gm, '').replace('export default function', 'function');
const slots = [], effects = [];
let cursor = 0, dirty = true, tree, props, pendingRead, reads = 0, failRead = false, notes = [];
const writes = [];
const changed = (a, b) => !a || a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]));
const hooks = {
  useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [slots[index].value, next => { const value = typeof next === 'function' ? next(slots[index].value) : next; if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; } }]; },
  useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
  useCallback(fn, deps) { const index = cursor++; if (changed(slots[index]?.deps, deps)) slots[index] = { value: fn, deps }; return slots[index].value; },
  useEffect(fn, deps) { const index = cursor++; if (changed(slots[index]?.deps, deps)) { const cleanup = slots[index]?.cleanup; slots[index] = { deps }; effects.push(() => { cleanup?.(); slots[index].cleanup = fn(); }); } },
};
function nodes(node, predicate, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (predicate(node)) result.push(node);
  for (const child of [node.props?.children].flat(Infinity)) nodes(child, predicate, result);
  return result;
}
const children = Object.fromEntries(['InterfaceIcon', 'SessionMenuFrame', 'SessionMenuPage', 'ModelSelector', 'Toggle', 'SummaryNoteStats',
  'OutputSettingsEditor', 'PromptCacheSettings', 'SessionPluginSettings', 'SessionWorkCombinationSettings', 'SessionThemeSettings',
  'SessionInformationSettings', 'SemiSessionSettings', 'MultichatApiSettings', 'MultichatProgressSettings'].map(name => [name, name]));
const Menu = vm.runInNewContext(compile(source).replace('export {};', '') + '\nSessionMenu', {
  jsx: createElement, Fragment, ...hooks, ...children,
  useAuth: () => ({ user: null }), ...providerFixture, getApiKey: () => '', normalizeOutputTokens: value => value ?? null, formatKrw: () => '', setTimeout: () => 0,
  summaryCompletionWarning: reason => reason === 'user_stop' ? '사용자 중지' : null,
  showConfirmDialog: async () => true,
  mutateSummary: async (_session, operation, id, content) => { writes.push({ operation, id, content }); notes = operation === 'delete' ? notes.filter(note => note.id !== id) : notes.map(note => note.id === id ? { ...note, content } : note); return props.session; },
  supabase: { from: table => { assert.equal(table, 'summary_versions'); return { select() { return this; }, eq() { return this; }, async order() {
    const snapshot = structuredClone(notes); const index = ++reads;
    if (index === 1) await new Promise(resolve => { pendingRead = resolve; });
    return failRead ? { error: { message: 'read unavailable' } } : { data: snapshot };
  } }; } },
});
props = { session: { id: 'room', user_note: '', total_cost: 0 }, profile: null, exchange: { rate: 1400 }, sessionReasoning: {}, storyNotes: [], errorLog: [], sessionTurnCount: 109,
  summaryGenerating: true, summaryContent: '첫 조각', onStopSummary() {}, onUpdate() {},
  onSummaryDraftChange: text => { props = { ...props, summaryContent: text }; dirty = true; },
};
const tick = () => new Promise(resolve => setImmediate(resolve));
async function flush() {
  for (let i = 0; i < 30; i++) {
    if (dirty) { dirty = false; cursor = 0; tree = Menu(props); }
    while (effects.length) effects.shift()();
    await tick();
    if (!dirty && !effects.length) return;
  }
  assert.fail('hook/effect state failed to settle');
}
const history = () => nodes(tree, node => node.type === 'SessionMenuPage' && node.props.title === '요약 노트 기록')[0];
const preview = () => nodes(history(), node => node.props?.['aria-label'] === '생성 중인 요약 노트')[0];
const buttons = (root, text) => nodes(root, node => node.type === 'button' && [node.props.children].flat(Infinity).includes(text));
const field = (root, label) => nodes(root, node => node.props?.['aria-label'] === label)[0];
const note = (content, reason = 'stop') => ({ id: 'note', content, summarized_through_turn: 109, created_at: '2026-11-09T05:47:00Z', is_active: true, finish_reason: reason });

await flush();
buttons(tree, '요약 노트 보기')[0].props.onClick(); await flush();
assert.equal(nodes(preview(), node => node.type === 'pre')[0].props.children, '첫 조각');
assert.equal(buttons(history(), '요약 생성 중지').length, 0);
notes = [note('정상 생성된 본문')];
props = { ...props, summaryGenerating: false, summaryContent: '' }; dirty = true; await flush();
assert.equal(buttons(history(), '편집').length, 1);
assert.equal(buttons(history(), '삭제').length, 1);
assert(!preview(), 'successful completion replaces the preview with a real editable note');
pendingRead(); await flush();
assert.equal(buttons(history(), '편집').length, 1, 'a late pre-completion empty read cannot erase the saved note');

props = { ...props, summaryGenerating: true, summaryContent: '중지 직전 본문' }; dirty = true; await flush();
assert.equal(buttons(history(), '요약 생성 중지').length, 0, 'history and merge controls never show Stop');
assert.equal(buttons(history(), '통합 생성')[0].props.disabled, true);
notes = [note('중지된 본문', 'user_stop')];
props = { ...props, summaryGenerating: false, summaryContent: '' }; dirty = true; await flush();
buttons(history(), '편집')[0].props.onClick(); await flush();
field(history(), '요약 노트 내용').props.onChange({ target: { value: '수정한 중지 본문' } }); await flush();
buttons(history(), '저장')[0].props.onClick(); await flush();
assert.equal(writes.at(-1).operation, 'edit'); assert.equal(notes[0].content, '수정한 중지 본문');

props = { ...props, summaryContent: '저장 실패 수신본' }; dirty = true; await flush();
buttons(preview(), '편집')[0].props.onClick(); await flush();
field(preview(), '수신한 요약 내용').props.onChange({ target: { value: '편집한 수신본' } }); await flush();
buttons(preview(), '편집 반영')[0].props.onClick(); await flush();
assert.equal(props.summaryContent, '편집한 수신본');
const before = writes.length;
await buttons(preview(), '삭제')[0].props.onClick(); await flush();
assert(!preview()); assert.equal(writes.length, before, 'discarding a local draft does not delete a persisted note');

failRead = true;
nodes(history(), node => node.type === 'SessionMenuPage')[0].props.onBack(); await flush();
buttons(tree, '요약 노트 보기')[0].props.onClick(); await flush();
assert.equal(buttons(history(), '편집').length, 1, 'read failures retain the last confirmed notes');
const readAlerts = () => nodes(history(), node => node.props?.role === 'alert' && [node.props.children].flat(Infinity).some(child => typeof child === 'string' && child.includes('불러오지 못했습니다')));
assert.equal(readAlerts().length, 1);
failRead = false; buttons(history(), '다시 불러오기')[0].props.onClick(); await flush();
assert.equal(readAlerts().length, 0);
await buttons(history(), '삭제')[0].props.onClick(); await flush();
assert.equal(notes.length, 0); assert.equal(writes.at(-1).operation, 'delete');
console.log('Summary history: actual menu JSX and dependency-aware effects, normal/stopped edit/delete, completion refresh, stale empty reads, draft edits/discard, no history Stop and read failure recovery passed.');
