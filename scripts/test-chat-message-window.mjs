import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const helper = compile(readFileSync(new URL('../src/lib/chatMessageWindow.ts', import.meta.url), 'utf8'));
const { latestChatMessageWindow, hasPassedLatestChatTurn } = await import('data:text/javascript;base64,' + Buffer.from(helper).toString('base64'));
const rows = count => Array.from({ length: count * 2 }, (_, index) => ({
  id: `message-${index}`, role: index % 2 ? 'assistant' : 'user', turn_index: Math.floor(index / 2) + 1,
  is_hidden: false, is_active_variant: true,
}));
for (const count of [0, 5, 6, 10]) {
  const messages = rows(count);
  assert.equal(latestChatMessageWindow(messages), messages, 'small windows retain the same state reference');
}
const expanded = rows(25);
expanded.push({ id: 'hidden', role: 'user', turn_index: 26, is_hidden: true },
  { id: 'inactive', role: 'assistant', turn_index: 20, is_active_variant: false });
const original = structuredClone(expanded);
const retained = latestChatMessageWindow(expanded);
assert.deepEqual(expanded, original, 'trimming cannot mutate saved rows');
assert.deepEqual(retained.filter(row => row.role === 'user' && !row.is_hidden).map(row => row.turn_index),
  Array.from({ length: 10 }, (_, index) => index + 16));
assert(retained.some(row => row.id === 'hidden'));
assert(retained.some(row => row.id === 'inactive'), 'all variants inside retained turns survive');
assert.equal(latestChatMessageWindow(retained), retained, 'trimming is idempotent');
const gapped = rows(12).map(row => ({ ...row, turn_index: row.turn_index * 3 }));
assert.equal(latestChatMessageWindow(gapped)[0].turn_index, 9, 'turn count handles nonconsecutive indices');

let latestTop = 550, bottomDistance = 40;
const element = {
  scrollHeight: 5000, clientHeight: 600,
  get scrollTop() { return this.scrollHeight - this.clientHeight - bottomDistance; },
  getBoundingClientRect: () => ({ bottom: 600 }),
  querySelectorAll: () => [{ getBoundingClientRect: () => ({ top: -200 }) },
    { getBoundingClientRect: () => ({ top: latestTop }) }],
};
assert.equal(hasPassedLatestChatTurn(element), false, 'a small upward movement keeps buttons hidden');
latestTop = 400;
assert.equal(hasPassedLatestChatTurn(element), false, 'reading inside the latest turn keeps buttons hidden');
latestTop = 600;
assert.equal(hasPassedLatestChatTurn(element), true, 'buttons appear after passing the latest complete turn');
bottomDistance = 0;
assert.equal(hasPassedLatestChatTurn(element), false, 'buttons stay hidden at the bottom');
assert.equal(hasPassedLatestChatTurn({ ...element, querySelectorAll: () => [] }), false);

// Execute the actual page callbacks, including a late older-page response.
const source = readFileSync(new URL('../src/pages/ChatPage.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ChatPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['collapseOlderMessages', 'loadOlderMessages', 'scrollToEdge']);
const declarations = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.has(node.name.getText(ast))) declarations.push(`const ${node.getText(ast)};`);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(declarations.length, names.size);
let current = rows(25), resolvePage, fetchBefore;
const state = {
  editingId: null, sessionId: 'fixture', oldestLoadedAt: 1, hasOlderServerMessages: false,
  useCallback: callback => callback, latestChatMessageWindow,
  editInFlightRef: { current: false }, deleteInFlightRef: { current: false },
  olderMessagesInFlightRef: { current: false }, olderMessagesRevisionRef: { current: 0 },
  collapsedToLatestRef: { current: false }, messageBoundaryRef: { current: { hasOlder: false, oldestTurn: null } },
  jumpToStartControllerRef: { current: new AbortController() }, messageReadControllerRef: { current: new AbortController() },
  scrollRef: { current: { scrollTop: 100, scrollHeight: 2000 } }, rememberScroll: () => {},
  setMessages: update => { current = update(current); },
  setHasOlderServerMessages: value => { state.hasOlderServerMessages = value; },
  setOldestLoadedAt: value => { state.oldestLoadedAt = value; }, setLoadingOlderMessages: () => {},
  addError: error => { throw Error(error); }, orderMessagesByTurn: list => list.sort((a, b) => a.turn_index - b.turn_index),
  fetchMessagePage: async (_session, before) => { fetchBefore = before; return new Promise(resolve => { resolvePage = resolve; }); },
};
const callbacks = vm.runInNewContext(compile(declarations.join('\n')).replace(/export \{\};?/, '')
  + '\n({collapseOlderMessages,loadOlderMessages,scrollToEdge})', state);
callbacks.scrollToEdge('end');
assert.equal(state.scrollRef.current.scrollTop, 2000);
assert.equal(current.length, 20);
assert.equal(state.oldestLoadedAt, 16);
assert.equal(state.hasOlderServerMessages, true);
assert.equal(state.jumpToStartControllerRef.current.signal.aborted, true);
const loading = callbacks.loadOlderMessages();
assert.equal(fetchBefore, 16, 'pagination restarts from the retained first turn');
callbacks.collapseOlderMessages();
resolvePage({ messages: rows(15).filter(row => row.turn_index >= 6), hasOlder: true, oldestTurn: 6 });
await loading;
assert.equal(current.length, 20, 'late older pages cannot undo a bottom reset');
assert.equal(state.oldestLoadedAt, 16);
assert.equal(state.olderMessagesInFlightRef.current, false);
const reloading = callbacks.loadOlderMessages();
resolvePage({ messages: rows(15).filter(row => row.turn_index >= 6), hasOlder: true, oldestTurn: 6 });
await reloading;
assert.equal(current.length, 40, 'scrolling back up loads the preceding ten turns again');
assert.equal(state.oldestLoadedAt, 6);
state.editingId = current[0].id;
callbacks.collapseOlderMessages();
assert.equal(current.length, 40, 'an open editor must survive a bottom reset');

// Use the real scroll hook to verify that releasing old rows keeps the bottom visible.
const hookState = { refs: [], effects: [], index: 0 };
const hookSource = readFileSync(new URL('../src/hooks/useChatScroll.ts', import.meta.url), 'utf8')
  .replace(/^import .*from 'react';\n/, '').replace('export function useChatScroll', 'function useChatScroll');
const useChatScroll = vm.runInNewContext(compile(hookSource).replace(/export \{\};?/, '') + '\nuseChatScroll', {
  useCallback: callback => callback,
  useRef: value => { const index = hookState.index++; return hookState.refs[index] ?? (hookState.refs[index] = { current: value }); },
  useLayoutEffect: effect => hookState.effects.push(effect),
});
let displayRows = rows(25), scrollTop = 0;
const height = row => row.role === 'user' ? 100 : 1800;
const viewport = {
  clientHeight: 600,
  get scrollHeight() { return displayRows.reduce((sum, row) => sum + height(row), 0); },
  get scrollTop() { return scrollTop; },
  set scrollTop(value) { scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
  getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
  querySelectorAll() {
    let y = 0;
    return displayRows.map(row => {
      const top = y; y += height(row);
      return { dataset: { scrollAnchor: row.id }, getBoundingClientRect: () => ({ top: top - scrollTop, bottom: top + height(row) - scrollTop }) };
    });
  },
};
function renderViewport() {
  hookState.index = 0; hookState.effects = [];
  const hook = useChatScroll('fixture', true); hook.scrollRef.current = viewport;
  hookState.effects.forEach(effect => effect()); return hook;
}
renderViewport().rememberScroll();
displayRows = latestChatMessageWindow(displayRows);
renderViewport();
assert.equal(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop, 0, 'trimming preserves the bottom through the real anchor hook');
console.log('Chat window: last ten turns, variants, hidden rows, repeat paging, stale-read rejection, editor preservation and whole-turn navigation visibility passed.');
