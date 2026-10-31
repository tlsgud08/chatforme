import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement, Fragment } from 'react';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React,
  jsxFactory: 'jsx', jsxFragmentFactory: 'Fragment',
} }).outputText;
function loadComponent(file, name, env) {
  const source = read(file).replace(/^import .*$/gm, '').replace('export default function', 'function');
  return vm.runInNewContext(compile(source).replace('export {};', '') + '\n' + name, { jsx: createElement, Fragment, ...env });
}
function nodes(node, predicate, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (predicate(node)) result.push(node);
  for (const child of [node.props?.children].flat(Infinity)) nodes(child, predicate, result);
  return result;
}
const writes = [], patches = [], state = [];
let cursor = 0;
const hooks = { useEffect() {}, useCallback: fn => fn, useRef: value => ({ current: value }),
  useState(initial) {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
  },
};
const supabase = { from: table => ({ update(patch) { writes.push({ table, patch }); return { eq: async () => ({ error: null }) }; } }) };
const children = Object.fromEntries(['InterfaceIcon', 'SessionMenuFrame', 'SessionMenuPage', 'ModelSelector', 'Toggle',
  'OutputSettingsEditor', 'PromptCacheSettings', 'SessionPluginSettings', 'SessionWorkCombinationSettings', 'SessionThemeSettings',
  'SessionInformationSettings', 'SemiSessionSettings', 'MultichatApiSettings', 'MultichatProgressSettings',
  'ModernPageHeading', 'InterfacePreferences', 'ThemePreferences', 'AdminSettings', 'SettingsAccessManager'].map(name => [name, name]));
let auth = { user: { id: 'owner' } };
const shared = { ...hooks, ...children, supabase, useAuth: () => auth,
  getApiKey: () => '', formatKrw: () => '', normalizeOutputTokens: value => value ?? null, setTimeout: () => 0,
};
const Menu = loadComponent('src/components/SessionMenu.tsx', 'SessionMenu', shared);
let props = { session: { id: 'room', total_cost: 0, user_note: '', summary_level_override: 0, summary_allow_omission_override: false },
  profile: { summary_level: 7, summary_allow_omission: true, summary_parameters_enabled: false },
  sessionReasoning: {}, exchange: { rate: 1400 }, errorLog: [], storyNotes: [], sessionTurnCount: 12,
  onUpdate: patch => { patches.push(patch);props = { ...props, session: { ...props.session, ...patch } }; },
};
function renderMenu() { cursor = 0; return Menu(props); }
let tree = renderMenu();
const level = nodes(tree, node => node.type === 'input' && node.props.max === 10)[0];
assert.equal(level.props.value, 0);
const omission = nodes(tree, node => node.props?.['aria-label'] === '요약 생략 허용')[0];
assert.equal(omission.props.checked, false);
const enabled = nodes(tree, node => node.props?.['aria-label'] === '요약 파라미터 함께 전송')[0];
assert.equal(enabled.props.checked, false); assert.ok(!enabled.props.disabled, 'global admin prompt permits switching parameters');
level.props.onChange({ target: { value: '10' } });
omission.props.onChange(true); enabled.props.onChange(true);
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(writes.map(write => JSON.parse(JSON.stringify(write.patch))), [
  { summary_level_override: 10 }, { summary_allow_omission_override: true }, { summary_parameters_enabled_override: true },
]);
assert.equal(patches.length, 3);
props = { ...props, session: { ...props.session, summary_level_override: null, summary_allow_omission_override: null } };
tree = renderMenu();assert.equal(nodes(tree, node => node.type === 'input' && node.props.max === 10)[0].props.value, 7);
const targetLabel = '[핵심 서사 및 맥락] 목표 토큰 수';
const target = nodes(tree, node => node.props?.['aria-label'] === targetLabel)[0];
assert.equal(target.props.type,'text');assert.equal(target.props.value,'3000');
target.props.onChange({target:{value:'4'}});target.props.onChange({target:{value:'4000~6000'}});
tree=renderMenu();assert.equal(nodes(tree,node=>node.props?.['aria-label']===targetLabel)[0].props.value,'4000~6000','text stays responsive while earlier requests are pending');
assert.equal(nodes(tree,node=>node.type==='button'&&[node.props.children].flat(Infinity).includes('지금 요약 노트 생성'))[0].props.disabled,true,'generation waits for the requested parameter to save');
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(writes.at(-1).patch.summary_narrative_target_tokens_override,'4000~6000','queued writes retain the final raw text');

const profile = { id: 'owner', default_model: 'fixture/model', summary_level: 4, summary_allow_omission: false,
  summary_parameters_enabled: true, summary_extra_note: 'EXTRA', summary_source_mode: 'full' };
state.length = 0; state[1] = profile;
const Settings = loadComponent('src/pages/SettingsPage.tsx', 'SettingsPage', { ...shared,
  ADMIN_EMAIL: '', loadApiKeys: () => ({ openrouter: '' }), modelsFor: () => ['fixture/model'], loadDefaultReasoning: () => ({}),
  loadTurnPriceWarning: () => ({ enabled: false, currency: 'KRW', threshold: 80 }), useUsdKrwRate: () => ({ rate: 1400 }),
  saveDefaultReasoning() {},
});
function renderSettings() { cursor = 0; return Settings(); }
tree = renderSettings();
const section = nodes(tree, node => node.props?.['data-settings-section'] === 'summary')[0];
assert.ok(section);
nodes(section, node => node.type === 'input' && node.props.max === 10)[0].props.onChange({ target: { value: '0' } });
tree = renderSettings();
nodes(tree, node => node.type === 'textarea' && node.props.placeholder === '요약 모델에 추가로 전달할 지침')[0].props.onChange({ target: { value: 'RESTORED NOTE' } });
tree = renderSettings();
assert.equal(nodes(tree,node=>node.props?.['aria-label']===targetLabel)[0].props.value,'3000');
nodes(tree,node=>node.props?.['aria-label']===targetLabel)[0].props.onChange({target:{value:'약 8000'}});tree=renderSettings();
await nodes(tree, node => node.type === 'button' && node.props.children === '요약 설정 저장')[0].props.onClick();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(writes.at(-1).table, 'profiles');assert.equal(writes.at(-1).patch.summary_level, 0);
assert.equal(writes.at(-1).patch.summary_extra_note, 'RESTORED NOTE');
assert.equal(writes.at(-1).patch.summary_allow_omission, false);assert.equal(writes.at(-1).patch.summary_parameters_enabled, true);
assert.equal(writes.at(-1).patch.summary_narrative_target_tokens,'약 8000');
console.log('Summary UI: original room controls, null inheritance, zero/false, immediate room writes and personal extra-note/parameter saves passed.');
for (const [isAdmin, canManageSettings] of [[true,true],[false,true],[false,false]]) {
  auth = { ...auth, isAdmin, canManageSettings };
  const view = renderSettings();
  assert.equal(nodes(view, node => node.type === 'AdminSettings').length, canManageSettings ? 1 : 0);
  assert.equal(nodes(view, node => node.type === 'SettingsAccessManager').length, isAdmin ? 1 : 0);
}
console.log('Settings page: founder sees role management, delegates see settings only, members see neither.');

const summaryPromptWithParameters = vm.runInNewContext(compile(read('src/lib/summaryPrompt.ts')
  .replace(/^import .*$/gm, '').replace(/\bexport /g, '')) + '\nsummaryPromptWithParameters');
const page = ts.createSourceFile('multi.tsx', read('src/pages/MultichatPage.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let processSource;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'processSummary') processSource = node.getText(page);
  ts.forEachChild(node, visit);
}
visit(page);assert.ok(processSource);
const requests = [], errors = [], completed = [];
const room = { id: 'room', summary: '', summary_last_turn: 0, summary_level_override: 0, summary_allow_omission_override: false };
const transcript = [{ id: 'u', role: 'user', content: 'ACTION', turn_index: 1 }, { id: 'a', role: 'assistant', content: 'STORY', turn_index: 1 }]
  .map(message => ({ ...message, is_active_variant: true, generation_status: 'complete' }));
const runSummary = vm.runInNewContext(compile(processSource) + '\nprocessSummary', {
  data: { session: room, room, profile }, me: { slot: 2 }, user: null,
  summaryLock: { current: false }, lock: { current: false }, controller: { current: null },
  getApiKey: () => 'fixture', setSummaryGenerating() {}, AbortController, setTimeout, clearTimeout,
  registerAccountTask: () => () => {}, multichatTranscript: async () => transcript,
  loadGlobalSummaryPrompt: async () => 'ADMIN CORE', summaryPromptWithParameters,
  normalizeReasoning: () => ({}), stripThemeDirectives: text => text,
  generate: async (_provider, request) => { requests.push(request); return { text: 'MEMORY', usage: { inputTokens: 1, outputTokens: 1, cost: 0 } }; },
  supabase: { from: () => ({ select() { return this; }, eq() { return this; }, in() { return this; }, single: async () => ({ data: room }) }),
    rpc: async (name, args) => { completed.push({ name, args }); return { data: room }; } },
  setSummaryPending() {}, patchSession() {}, refresh: async () => {}, report: error => errors.push(error), errorText: error => error.message,
});
await runSummary({ id: 'ticket', token: 'token', through: 1, mergeIds: [] });
assert.deepEqual(errors, []);
assert.equal(requests[0].systemParts.core, 'ADMIN CORE\n\n[SUMMARY CONFIGURATION]\nSUMMARY_LEVEL = 0\nALLOW_OMISSION = OFF\nCORE_NARRATIVE_TARGET_TOKENS = 3000\nApply this target token count only to [핵심 서사 및 맥락], not to the entire archive.\n\n[ADDITIONAL NOTE]\nEXTRA');
assert.equal(completed[0].name, 'finish_multichat_summary');
room.summary_parameters_enabled_override = false;
await runSummary({ id: 'ticket2', token: 'token', through: 1, mergeIds: [] });
assert.deepEqual(errors, []);assert.equal(requests[1].systemParts.core, 'ADMIN CORE\n\n[ADDITIONAL NOTE]\nEXTRA');
assert.equal(requests[0].messages[0].content, requests[1].messages[0].content, 'controls do not alter the transcript');
console.log('Real multichat summary handler: PC2 payer path, room overrides, parameters OFF, extra note and unchanged source messages passed.');
