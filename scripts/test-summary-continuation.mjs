import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement, Fragment } from 'react';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React,
  jsxFactory: 'jsx', jsxFragmentFactory: 'Fragment',
} }).outputText.replace('export {};', '');
const chat = ts.createSourceFile('ChatPage.tsx', read('src/pages/ChatPage.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  let source;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) source = node.getText(chat);
    ts.forEachChild(node, visit);
  }
  visit(chat);
  assert.ok(source, name);
  return source;
}

const requests = [], saves = [], errors = [];
const session = { id: 'room', summary: 'OLD MEMORY', summary_last_turn: 10 };
const profile = { default_model: 'fixture/model' };
let notes = [{ id: 'note10', content: 'MEMORY THROUGH TEN', summarized_through_turn: 10 }];
let noteReads = 0;
const messages = Array.from({ length: 30 }, (_, index) => ['user', 'assistant'].map(role => ({
  id: role + (index + 1), role, content: role + '-TURN-' + (index + 1) + '-END',
  turn_index: index + 1, generation_status: 'complete', is_active_variant: true,
}))).flat();
const activeSummaryGenerations = new Map();
const noop = () => {};
const scope = {
  session, profile, contextReady: true, summaryGenerating: false, activeGenerations: new Map(), activeSummaryGenerations,
  ...Object.fromEntries(['editInFlightRef', 'deleteInFlightRef', 'branchInFlightRef', 'sendInFlightRef', 'workCombinationSavingRef', 'summarySaveRequestRef'].map(name => [name, { current: null }])),
  getApiKey: () => 'fixture', AbortController, registerAccountTask: () => noop,
  ...Object.fromEntries(['setSummarySaving', 'setSummaryContent', 'setSummaryGenerating', 'publishSummaryContent', 'markSummarySaving', 'setMessages', 'setSession', 'showToast'].map(name => [name, noop])),
  finishSummaryGeneration: id => activeSummaryGenerations.delete(id),
  readLiveThemeContext: async () => ({}), recoverExpiredResponses: async () => {},
  fetchAllSessionMessages: async () => messages,
  summaryNarrativeConfig: () => ({}), automaticThemeEnabled: () => false,
  stripThemeDirectives: text => text, normalizeThemePeriods: text => text,
  loadGlobalSummaryPrompt: async () => 'PROMPT', summaryPromptWithParameters: text => text,
  normalizeReasoning: () => ({}), loadSemiContext: async () => null, withoutSyncDateTags: request => request,
  generate: noop,
  generateSummaryResponse: async (_generate, request) => {
    requests.push(request);
    return { text: 'NEW MEMORY', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, cost: 0 } };
  },
  summaryResultMetadata: () => ({}), summaryCompletionWarning: () => null,
  saveSummaryWithFallback: async (_rpc, request) => { saves.push(request); return { data: session }; },
  summaryAchievementToast: () => ({ message: 'saved' }), isUserSummaryStop: () => false,
  addError: error => errors.push(error), describeUnknownError: error => error.message,
  supabase: { from: () => {
    noteReads++;
    return { select() { return this; }, eq() { return this; }, lt(_column, turn) { this.turn = turn; return this; },
      order() { return this; }, async limit() { return { data: notes.filter(note => note.summarized_through_turn < this.turn).sort((a, b) => b.summarized_through_turn - a.summarized_through_turn).slice(0, 1) }; } };
  } },
};
const generateSummary = vm.runInNewContext(compile(['messagesAfterSummary', 'messagesThroughTurn', 'generateSummary'].map(declaration).join('\n')) + '\ngenerateSummary', scope);
assert.equal(await generateSummary(), true);
assert.equal(noteReads, 0, 'OFF defaults to the entire transcript');
assert.match(requests.at(-1).messages[0].content, /user-TURN-1-END/);
assert.doesNotMatch(requests.at(-1).messages[0].content, /OLD MEMORY|MEMORY THROUGH TEN/);
session.summary_source_mode_override = 'incremental';
assert.equal(await generateSummary(), true);
const incremental = requests.at(-1).messages[0].content;
assert.match(incremental, /MEMORY THROUGH TEN/);
for (let turn = 1; turn <= 10; turn++) assert(!incremental.includes('-TURN-' + turn + '-END'));
for (let turn = 11; turn <= 30; turn++) assert(incremental.includes('user-TURN-' + turn + '-END'));
assert.equal(saves.at(-1).through_turn, 30);
assert.equal(saves.at(-1).source_versions.filter(item => !item.kind).length, 40);
notes.push({ id: 'future', content: 'FUTURE MEMORY', summarized_through_turn: 25 });
assert.equal(await generateSummary([], 20), true);
assert.doesNotMatch(requests.at(-1).messages[0].content, /FUTURE MEMORY|user-TURN-21-END/);
assert.match(requests.at(-1).messages[0].content, /MEMORY THROUGH TEN/);
notes = [];
session.summary = ''; session.summary_last_turn = 0;
assert.equal(await generateSummary(), true);
assert.match(requests.at(-1).messages[0].content, /user-TURN-1-END/, 'ON without a previous note starts at turn one');
profile.summary_source_mode = 'incremental'; session.summary_source_mode_override = 'full';
assert.equal(await generateSummary(), true);
assert.match(requests.at(-1).messages[0].content, /user-TURN-1-END/, 'room OFF overrides account ON');
assert.deepEqual(errors, []);

// Render the actual room controls and verify the switch saves the existing source mode.
let states = [], cursor = 0;
const hooks = {
  useState(initial) { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
  useEffect: noop, useCallback: fn => fn, useRef: value => ({ current: value }),
  useQuery: () => ({}), useQueryClient: () => ({}), lazy: () => 'SceneShareSettings',
};
function nodes(node, predicate, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (predicate(node)) result.push(node);
  for (const child of [node.props?.children].flat(Infinity)) nodes(child, predicate, result);
  return result;
}
const children = Object.fromEntries(['InterfaceIcon', 'SessionMenuFrame', 'SessionMenuPage', 'ModelSelector', 'Toggle',
  'OutputSettingsEditor', 'PromptCacheSettings', 'SessionPluginSettings', 'SessionWorkCombinationSettings', 'SessionThemeSettings',
  'SessionInformationSettings', 'SemiSessionSettings', 'PersonaDeathSettings', 'MultichatApiSettings', 'MultichatProgressSettings', 'Suspense'].map(name => [name, name]));
const patches = [];
const room = { id: 'room', user_note: '', total_cost: 0 };
const menu = vm.runInNewContext(compile(read('src/components/SessionMenu.tsx').replace(/^import .*$/gm, '').replace('export default function', 'function')) + '\nSessionMenu', {
  jsx: createElement, Fragment, ...hooks, ...children, useAuth: () => ({}), getApiKey: () => '',
  normalizeOutputTokens: value => value ?? null, summaryCompletionWarning: () => null, setTimeout: noop,
  supabase: { from: () => ({ update: patch => ({ eq: async () => { patches.push(patch); return {}; } }) }) },
});
const render = (account = {}) => { cursor = 0; return menu({
  session: room, profile: account, storyNotes: [], sessionReasoning: {}, errorLog: [], exchange: {}, sessionTurnCount: 30,
  onUpdate: patch => Object.assign(room, patch),
}); };
let tree = render();
const control = label => nodes(tree, node => node.props?.['aria-label'] === label)[0];
assert.equal(nodes(tree, node => node.type === 'input' && node.props.max === 10)[0].props.value, 0);
assert.equal(control('요약 생략 허용').props.checked, false);
assert.equal(control('지난 메모리와 이어서 생성').props.checked, false);
const switches = nodes(tree, node => node.type === 'Toggle');
assert.equal(switches.findIndex(node => node.props['aria-label'] === '지난 메모리와 이어서 생성'),
  switches.findIndex(node => node.props['aria-label'] === '요약 생략 허용') + 1);
await control('지난 메모리와 이어서 생성').props.onChange(true);
assert.equal(patches.at(-1).summary_source_mode_override, 'incremental');
tree = render();
assert.equal(control('지난 메모리와 이어서 생성').props.checked, true);
await control('지난 메모리와 이어서 생성').props.onChange(false);
tree = render({ summary_source_mode: 'incremental' });
assert.equal(control('지난 메모리와 이어서 생성').props.checked, false);
room.summary_source_mode_override = null;
tree = render({ summary_source_mode: 'incremental' });
assert.equal(control('지난 메모리와 이어서 생성').props.checked, true);
console.log('Summary continuation passed: defaults, control order, saved ON/OFF, inheritance, 11–30 payload, missing note and earlier checkpoints.');
