import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
import { approvedSummaryLengthDirective } from './fixtures/summary-length.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.React, jsxFactory: 'jsx',
} }).outputText;
const importSource = async source => import('data:text/javascript;base64,' + Buffer.from(compile(source)).toString('base64'));
const { parseSummaryTarget, extractCoreNarrative, countNarrativeCharacters, summaryNarrativeConfig, summaryAchievementToast } =
  await importSource(read('src/lib/summaryNarrative.ts'));
const prompt = vm.runInNewContext(compile(read('src/lib/summaryPrompt.ts').replace(/^import .*$/gm, '').replace(/\bexport /g, '')) + '\nsummaryPromptWithParameters');
const configured = prompt('SHARED', { summary_extra_note: 'USER NOTE' }, { summary_narrative_target_chars_override: '20000' });
assert(configured.endsWith(approvedSummaryLengthDirective('20000')), 'approved English is verbatim, dynamic and the final system block');
assert.equal(prompt('SHARED', {}, { summary_parameters_enabled_override: false }), 'SHARED');
assert.deepEqual(summaryNarrativeConfig({ summary_narrative_target_chars: '8000' }, {}), { unit: 'characters', enabled: true, target: '8000' });
assert.deepEqual(summaryNarrativeConfig({ summary_narrative_target_chars: '8000' }, { summary_narrative_target_chars_override: '20000', summary_parameters_enabled_override: false }), { unit: 'characters', enabled: false, target: '20000' });
for (const value of ['20000', '20,000', '약 20000', 'approximately 20000 characters', '２００００ 자']) {
  assert.deepEqual(parseSummaryTarget(value), { minimum: 20000, maximum: 20000 });
}
assert.deepEqual(parseSummaryTarget('4,000 ~ 6,000'), { minimum: 4000, maximum: 6000 });
for (const value of ['', '0', '-100', '20,00', '5000~3000', '20000 or 30000', '9007199254740992', 'please use as many tokens as needed']) {
  assert.equal(parseSummaryTarget(value), null, value);
}
const body = '[날짜불명]\n인물은 행동하고 상대는 응답했다.\n[2050년 1월 2일]\n다음 사건.';
const archive = narrative => `[주요인물]\n${'인물정보'.repeat(500)}\n\n## **[핵심 서사 및 맥락]**\n${narrative}\n\n[주요 약속/계획]\n${'약속'.repeat(500)}\n[종합 상황]\n관계 유지`;
assert.equal(extractCoreNarrative(archive(body)), body, 'only narrative counts, including standalone date markers');
assert.equal(extractCoreNarrative('```text\n' + archive(body) + '\n```'), body, 'whole-document code fences are supported');
assert.equal(extractCoreNarrative('[핵심 서사 및 맥락]\n내용\n=== 요약 내용 끝. ===\n부록'), '내용');
assert.equal(extractCoreNarrative('[핵심 서사 및 맥락]\n내용\n[주요 갈등]\n충돌'), '내용');
assert.equal(extractCoreNarrative('> [핵심 서사 및 맥락]\n인용문'), null, 'a quoted heading is not a section');
assert.equal(extractCoreNarrative('```text\n[핵심 서사 및 맥락]\n예시\n```\n다른 내용'), null, 'embedded code is not mistaken for a section');
assert.equal(extractCoreNarrative('[핵심 서사 및 맥락]\n하나\n[주요인물]\n인물\n[핵심 서사 및 맥락]\n둘'), null, 'ambiguous duplicates report unknown');
assert.equal(extractCoreNarrative('[주요인물]\n인물만 있음'), null);
assert.equal(extractCoreNarrative('[핵심 서사 및 맥락]\n\n[주요 갈등]\n없음'), '');
const config = { unit: 'characters', enabled: true, target: '20000' };
const toast = summaryAchievementToast(archive('x'.repeat(12480)), config, 'stop');
assert.match(toast.message, /62% \(12,480 \/ 20,000자\) 달성/);
assert.equal(toast.tone, 'warning'); assert.equal(toast.durationMs, 6500);
assert.match(summaryAchievementToast(archive('x'.repeat(22000)), config, 'stop').message, /110%/, 'percentages above 100 are not capped');
assert.match(summaryAchievementToast(archive(body), config, 'length').message, /출력 제한으로 중단/);
assert.match(summaryAchievementToast(archive(body), { unit: 'characters', enabled: false, target: '20000' }, 'stop').message, /목표 미적용/);
assert.match(summaryAchievementToast('missing', config, 'stop').message, /분량 확인 불가/);
assert.match(summaryAchievementToast(archive(body), { unit: 'characters', enabled: true, target: 'not numeric' }, 'stop').message, /목표 분량 해석 불가/);
assert.match(summaryAchievementToast(archive(body), { unit: 'characters', enabled: true, target: '4000~6000' }, 'stop').message, /범위 하한 대비/);
assert.equal(countNarrativeCharacters(''), 0);
assert.equal(countNarrativeCharacters('가 나\r\n다\n'), 4, 'spaces count and CR/LF do not');
assert.equal(countNarrativeCharacters('가'), 1, 'decomposed Hangul is one visible character');
assert.equal(countNarrativeCharacters('👩‍💻🇰🇷'), 2, 'combined emoji are counted as graphemes');
assert.deepEqual(summaryNarrativeConfig({ summary_narrative_target_tokens: '20000' }, {}), { unit: 'characters', enabled: true, target: '10000' }, 'legacy tokens are not reinterpreted as characters');


// Retry a retained multi-chat response without re-generating or sending local-only metadata to SQL.
const multiPage = ts.createSourceFile('multi.tsx', read('src/pages/MultichatPage.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let retrySource;
function findRetry(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'retrySummarySave') retrySource = node.getText(multiPage);
  ts.forEachChild(node, findRetry);
}
findRetry(multiPage); assert(retrySource);
const savedCalls = [], notifications = [], retryErrors = [];
let rejectSave = false;
const retry = vm.runInNewContext(compile(retrySource) + '\nretrySummarySave', {
  summaryPending: { target_room: 'room', summary_text: archive('x'.repeat(12480)), generation_finish_reason: 'stop', narrative_config: config },
  summaryLock: { current: false }, setSummaryGenerating() {}, user: null,
  supabase: { rpc: async (name, args) => { savedCalls.push({ name, args }); return { data: {}, error: rejectSave ? Error('save denied') : null }; } },
  setSummaryPending() {}, patchSession() {}, refresh: async () => {}, report: error => retryErrors.push(error),
  summaryCompletionWarning: () => null, summaryAchievementToast, showToast: (text, options) => notifications.push({ text, options }),
});
await retry(); assert.equal(notifications.length, 1); assert.match(notifications[0].text, /62%/);
assert(!('narrative_config' in savedCalls[0].args), 'notification-only data never becomes a PostgREST RPC argument');
rejectSave = true; await retry(); assert.equal(notifications.length, 1); assert.equal(retryErrors.length, 1);

// Exercise the actual app-wide event API and rendered toast, including old callers.
const originalWindow = globalThis.window;
const browser = new EventTarget(), timers = new Map(), listeners = new Map();
let nextTimer = 0, cursor = 0;
const states = [], effects = [];
browser.addEventListener = (name, handler) => listeners.set(name, handler);
browser.removeEventListener = name => listeners.delete(name);
browser.dispatchEvent = event => { listeners.get(event.type)?.(event); return true; };
globalThis.window = browser;
try {
  const { showToast, TOAST_EVENT } = await importSource(read('src/lib/toast.ts'));
  const AppToast = vm.runInNewContext(compile(read('src/components/AppToast.tsx').replace(/^import .*$/gm, '').replace('export default function', 'function')).replace('export {};', '') + '\nAppToast', {
    jsx: createElement, TOAST_EVENT, window: browser,
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
    useRef: () => ({}), useEffect: fn => effects.push(fn),
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
  });
  const render = () => { cursor = 0; return AppToast(); };
  render(); const cleanup = effects[0]();
  showToast('existing notification');
  assert.equal([...timers.values()][0].ms, 2600);
  showToast(toast.message, toast);
  const view = render();
  assert.equal(timers.size, 1, 'a new message cancels the previous timeout');
  assert.equal([...timers.values()][0].ms, 6500);
  assert.equal(view.props.role, 'status');
  assert.match(view.props.children.props.className, /bg-amber-700/);
  assert.equal(view.props.children.props.children, toast.message);
  [...timers.values()][0].fn(); assert.equal(render(), null);
  cleanup(); assert.equal(listeners.size, 0);
} finally {
  if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
}
console.log('Summary narrative: approved English, configuration, numeric/range targets, section isolation, dates/fences, exact character counts, partial/missing results and real top-toast events passed.');
