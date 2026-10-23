import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const originalFetch = globalThis.fetch;
globalThis.window = { location: { origin: 'https://example.test' } };
try {
  const { assemblePrompt } = await server.ssrLoadModule('/src/lib/prompt/assemble.ts');
  const { generate } = await server.ssrLoadModule('/src/lib/llm/index.ts');
  const { combinedWorkIds, workCombinationPrompt } = await server.ssrLoadModule('/src/lib/workCombination.ts');
  const { loadWorkCombination, saveWorkCombination, searchCombinationWorks, fetchCombinationWorkInfo } = await server.ssrLoadModule('/src/lib/workCombinationData.ts');
  const { supabase } = await server.ssrLoadModule('/src/lib/supabase.ts');
  const main = '10000000-0000-0000-0000-000000000001';
  const a = '10000000-0000-0000-0000-000000000002';
  const b = '10000000-0000-0000-0000-000000000003';
  const workA = { id: a, title: '작품 A <"&>', main_prompt: '\n A 원문 \n' };
  const workB = { id: b, title: '작품 B', main_prompt: ' B 원문  ' };
  const combination = { enabled: true, mainWorkId: main, mainWorkTitle: '메인', instruction: '관리자가 편집한 지침', works: [workA, workB] };

  async function bodyFor(input, options) {
    let body;
    globalThis.fetch = async (_url, request) => {
      body = request.body;
      return new Response(JSON.stringify({ id: 'fixture', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 12, completion_tokens: 2, cost: 0 } }), { headers: { 'content-type': 'application/json' } });
    };
    await generate('openrouter', { apiKey: 'test-key', sessionId: 'fixture-room', ...options, ...assemblePrompt(input) });
    return body;
  }
  // These bytes were captured from the unchanged assembler at base 3e4b255.
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/work-combination-disabled.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) {
    for (const setting of [undefined, { ...combination, enabled: false }, { ...combination, works: [] }]) {
      assert.equal(await bodyFor({ ...fixture.input, workCombination: setting }, fixture.options), fixture.expectedBody, `${fixture.name}: unused feature must preserve the complete serialized payload`);
    }
    const original = JSON.parse(fixture.expectedBody);
    const active = JSON.parse(await bodyFor({ ...fixture.input, workCombination: combination }, fixture.options));
    assert.deepEqual({ ...active, messages: original.messages }, original, 'request options must not change');
    assert.deepEqual(active.messages.filter(item => item.role !== 'system'), original.messages.filter(item => item.role !== 'system'), 'history, commands and cache markers must not change');
    if (original.messages.some(item => item.role === 'system')) assert.deepEqual(active.messages.map(item => item.role), original.messages.map(item => item.role));
  }
  const prompt = workCombinationPrompt('\n main RAW \n', combination);
  assert.ok(prompt.includes('\n main RAW \n'));
  assert.ok(prompt.includes(workA.main_prompt));
  assert.ok(prompt.includes(workB.main_prompt));
  assert.ok(prompt.indexOf(combination.instruction) < prompt.indexOf('<main_work'));
  assert.ok(prompt.indexOf('<main_work') < prompt.indexOf('<additional_work'));
  assert.ok(prompt.indexOf(workA.main_prompt) < prompt.indexOf(workB.main_prompt));
  assert.match(prompt, /priority="highest"/);
  assert.match(prompt, /priority="1"/);
  assert.match(prompt, /priority="2"/);
  assert.match(prompt, /A &lt;&quot;&amp;&gt;/);
  assert.ok(!workCombinationPrompt('main', { ...combination, instruction: '' }).includes('Work Combination Rules'));
  const reversed = workCombinationPrompt('main', { ...combination, works: [workB, workA] });
  assert.ok(reversed.indexOf(workB.main_prompt) < reversed.indexOf(workA.main_prompt));
  for (const invalid of [[main], [a, a], ['bad'], [null], {}]) assert.throws(() => combinedWorkIds(invalid, main));
  assert.deepEqual(combinedWorkIds(undefined, main), []);
  assert.deepEqual(combinedWorkIds([a, b], main), [a, b]);
  assert.throws(() => workCombinationPrompt('main', { ...combination, works: [{ ...workA, main_prompt: '  ' }] }));

  // Record real data-layer chains without contacting a live project.
  const calls = [];
  let rows = [workB, workA];
  let config = { work_combination_prompt: 'live admin instruction' };
  let responseError = null;
  let storedPatch;
  const originalFrom = supabase.from;
  supabase.from = table => {
    const call = { table, filters: {} };
    calls.push(call);
    const builder = {
      select(columns) { call.columns = columns; return this; },
      update(patch) { storedPatch = patch; return this; },
      eq(key, value) { call.filters[key] = value; return this; },
      neq(key, value) { call.filters[`neq:${key}`] = value; return this; },
      or(value) { call.or = value; return this; },
      ilike(key, value) { call.ilike = [key, value]; return this; },
      order() { return this; }, range(start, end) { call.range = [start, end]; return this; },
      in(key, values) { call.ids = values; return this; },
      abortSignal(signal) { call.signal = signal; return this; }, single() { return this; },
      then(resolve, reject) {
        return Promise.resolve({ data: table === 'platform_config' ? config : table === 'sessions' ? storedPatch : rows.filter(row => !call.ids || call.ids.includes(row.id)), error: responseError }).then(resolve, reject);
      },
    };
    return builder;
  };
  try {
    const state = { id: 'room', user_id: 'owner', work_id: main, work_combination_enabled: true, combined_work_ids: [a, b] };
    const mainWork = { id: main, title: 'Main' };
    for (const disabledState of [{ ...state, work_combination_enabled: false, combined_work_ids: ['bad'] }, { ...state, work_combination_enabled: undefined }, { ...state, combined_work_ids: [] }]) {
      calls.length = 0;
      assert.equal(await loadWorkCombination(disabledState, mainWork), undefined);
      assert.equal(calls.length, 0, 'inactive/empty combinations must not query prompts or config');
    }
    const loaded = await loadWorkCombination(state, mainWork);
    assert.deepEqual(loaded.works, [workA, workB], 'database order must not change selected priorities');
    assert.equal(loaded.instruction, 'live admin instruction');
    config.work_combination_prompt = 'updated';
    assert.equal((await loadWorkCombination(state, mainWork)).instruction, 'updated');
    config.work_combination_prompt = '';
    assert.equal((await loadWorkCombination(state, mainWork)).instruction, '');
    config = {};
    await assert.rejects(() => loadWorkCombination(state, mainWork), /지침/);
    config = { work_combination_prompt: 'rules' };
    rows = [workA];
    await assert.rejects(() => loadWorkCombination(state, mainWork), /추가 2순위.*접근 권한/);
    rows = [workA, { ...workB, main_prompt: '\n' }];
    await assert.rejects(() => loadWorkCombination(state, mainWork), /추가 2순위.*비어/);
    rows = [workA, workB];
    await assert.rejects(() => loadWorkCombination({ ...state, combined_work_ids: [a, a] }, mainWork), /중복/);
    responseError = { code: 'NETWORK' };
    await assert.rejects(() => loadWorkCombination(state, mainWork), /불러오지/);
    responseError = null;
    calls.length = 0;
    await searchCombinationWorks('100%_\\', main, 'owner', 2);
    assert.equal(calls[0].columns, 'id,title,description');
    assert.deepEqual(calls[0].ilike, ['title', '%100\\%\\_\\\\%']);
    assert.deepEqual(calls[0].range, [40, 59]);
    assert.equal(calls[0].filters['neq:id'], main);
    assert.equal(calls[0].or, 'visibility.neq.unlisted,creator_id.eq.owner', 'ordinary users retain unlisted discovery rules');
    for (const title of ['明治ロマン', '한국어 작품', 'English Title']) {
      calls.length = 0;
      await searchCombinationWorks(title, main, 'owner', 0, undefined, true);
      assert.deepEqual(calls[0].ilike, ['title', `%${title}%`], 'search must preserve multilingual titles');
      assert.equal(calls[0].or, undefined, 'administrators must not lose accessible unlisted works');
      assert.equal(calls[0].columns, 'id,title,description', 'search must not fetch prompts');
    }
    calls.length = 0;
    await fetchCombinationWorkInfo(Array.from({ length: 205 }, (_, index) => String(index)));
    assert.deepEqual(calls.map(call => call.ids.length), [100, 100, 5], 'large lists must not overflow query URLs');
    assert.ok(calls.every(call => call.columns === 'id,title,description'));
    await saveWorkCombination(state, 'owner', false, [b, a]);
    assert.deepEqual(storedPatch, { work_combination_enabled: false, combined_work_ids: [b, a] });
    const saved = calls.at(-1);
    assert.equal(saved.filters.user_id, 'owner');
    assert.equal(saved.filters.work_id, main);
    assert.equal(saved.filters.combined_work_ids, `{${a},${b}}`, 'compare-and-set prevents stale overwrites');
    responseError = { code: 'PGRST116' };
    await assert.rejects(() => saveWorkCombination(state, 'owner', true, [b]), /다른 화면/);
    responseError = { code: 'PGRST204' };
    await assert.rejects(() => saveWorkCombination(state, 'owner', true, [b]), /DB 업데이트/);
  } finally {
    supabase.from = originalFrom;
  }
  console.log('Work combination: 15 byte-for-byte payload fixtures, priority, validation, live reads, search, batching and concurrent saves passed.');
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
}
