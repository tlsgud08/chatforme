import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { activeThemeWorkIds, workThemeScopeKey } = await server.ssrLoadModule('/src/lib/workCombination.ts');
  const { loadWorkThemeCatalog } = await server.ssrLoadModule('/src/lib/workThemeData.ts');
  const h = await server.ssrLoadModule('/src/lib/themeDirectives.ts');
  const { assemblePrompt } = await server.ssrLoadModule('/src/lib/prompt/assemble.ts');
  const { supabase } = await server.ssrLoadModule('/src/lib/supabase.ts');
  const { DEFAULT_DARK, DEFAULT_LIGHT } = await server.ssrLoadModule('/src/lib/theme.ts');
  const id = n => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const [main, extra, third] = [id(1), id(2), id(3)];
  const room = { work_id: main, work_combination_enabled: true, combined_work_ids: [extra, third] };
  const theme = (n, work, props = {}) => ({ id: id(n), name: '궁궐', description: '', owner_id: 'author', work_id: work, work_shared: true, ai_prompt: '궁궐에서 사용', dark_colors: DEFAULT_DARK, light_colors: DEFAULT_LIGHT, ...props });
  const themes = [theme(10, main), theme(11, extra), theme(12, third), theme(13, extra, { work_shared: false, owner_id: 'owner' }), theme(14, extra, { work_shared: false, owner_id: 'other' }), theme(15, null), theme(16, id(99))];
  let works = [{ id: main, title: '메인' }, { id: extra, title: '추가' }, { id: third, title: '추가' }];
  let rows = themes;
  const calls = [];
  let fail = null;
  const originalFrom = supabase.from;
  supabase.from = table => {
    const call = { table, filters: {} };
    calls.push(call);
    const chain = {
      select(columns) { call.columns = columns; return this; },
      eq(key, value) { call.filters[key] = [value]; return this; },
      in(key, values) { call.filters[key] = values; return this; },
      order() { return this; },
      range(from, to) { call.range = [from, to]; return this; },
      abortSignal(signal) { call.signal = signal; return this; },
      then(resolve, reject) {
        let data = (table === 'works' ? works : rows).filter(row => Object.entries(call.filters).every(([key, values]) => values.includes(row[key])));
        if (call.range) data = data.slice(call.range[0], call.range[1] + 1);
        return Promise.resolve({ data: fail === table ? null : data, error: fail === table ? { message: 'offline' } : null }).then(resolve, reject);
      },
    };
    return chain;
  };
  try {
    const catalog = await loadWorkThemeCatalog(room, 'owner');
    assert.deepEqual(catalog.themes.map(t => t.id), themes.slice(0, 4).map(t => t.id));
    assert.deepEqual(catalog.scope.workNames, Object.fromEntries(works.map(w => [w.id, w.title])));
    const text = h.themeCatalogPrompt(catalog.themes, true, catalog.scope);
    for (const selected of catalog.themes) {
      const tag = `id:${selected.id}:밤`;
      assert.ok(text.includes('- 이름: ' + tag));
      assert.deepEqual(h.resolveThemeDirectiveChoice(tag, catalog.themes, true, true), { theme: selected, period: 'night' });
      assert.deepEqual(h.resolveThemeDirectiveChoice(tag, catalog.themes, false, true), { theme: selected, period: null });
    }
    assert.equal(h.resolveThemeDirectiveChoice('궁궐:밤', catalog.themes, true, true), null, 'same-name choices must never pick by priority');
    assert.equal(h.resolveThemeDirectiveChoice('id:' + id(999), catalog.themes, false, true), null);
    assert.equal(h.resolveThemeDirectiveChoice('keep', catalog.themes, true, true), null);
    assert.equal(text, h.themeCatalogPrompt([...catalog.themes].reverse(), true, catalog.scope));
    const renamed = catalog.themes.map(t => ({ ...t, name: '변경 이름' }));
    assert.equal(h.resolveThemeDirectiveChoice(`id:${themes[1].id}:밤`, renamed, true, true).theme.id, themes[1].id);
    const unique = theme(21, extra, { name: '유일' });
    assert.equal(h.resolveThemeDirectiveChoice('유일:밤', [...catalog.themes, unique], true, true).theme.id, unique.id);
    const raw = `본문 {{theme::id:${themes[1].id}:밤}}`;
    const input = { systemPrompt: 'GLOBAL', mainPrompt: 'MAIN', autoThemeEnabled: true, themePrompt: 'RULES', themeCatalog: text, dayNightThemeNames: h.dayNightCatalogNames(catalog.themes, true), history: [{ role: 'assistant', content: raw, cacheBreakpoint: true }], latestUserMessage: '계속' };
    assert.equal(assemblePrompt(input).messages[0].content, raw);
    assert.equal(assemblePrompt({ ...input, dayNightThemeNames: [] }).messages[0].content, `본문 {{theme::id:${themes[1].id}}}`);
    const fixed = assemblePrompt({ ...input, autoThemeEnabled: false });
    assert.ok(!JSON.stringify(fixed).includes('{{theme::'));
    assert.ok(!fixed.systemParts.core.includes('Available Work Themes'));
    assert.equal(input.history[0].content, raw);

    for (const unused of [{ ...room, work_combination_enabled: false, combined_work_ids: ['invalid'] }, { ...room, work_combination_enabled: undefined }, { ...room, combined_work_ids: [] }]) {
      calls.length = 0;
      const single = await loadWorkThemeCatalog(unused, 'owner');
      assert.equal(single.scope, undefined);
      assert.deepEqual(single.themes.map(t => t.id), [themes[0].id]);
      assert.ok(calls.every(call => call.table === 'themes'), 'inactive combinations must not add work metadata reads');
      assert.equal(h.themeCatalogPrompt(single.themes), h.themeCatalogPrompt([themes[0]]));
      assert.deepEqual(activeThemeWorkIds(unused), [main]);
    }
    assert.notEqual(workThemeScopeKey(room), workThemeScopeKey({ ...room, work_combination_enabled: false }));
    assert.deepEqual(activeThemeWorkIds(room), [main, extra, third]);
    const active = themes[1];
    const off = await loadWorkThemeCatalog({ ...room, work_combination_enabled: false }, 'owner');
    assert.equal(h.resolveThemeDirectiveChoice(`id:${active.id}:밤`, off.themes, true), null, 'removed work IDs are ignored');
    for (const table of ['themes', 'works']) {
      fail = table;
      await assert.rejects(() => loadWorkThemeCatalog(room, 'owner'), /불러오지/);
    }
    fail = null;
    works = works.slice(0, 2);
    await assert.rejects(() => loadWorkThemeCatalog(room, 'owner'), /접근 권한/);
    const aborted = new AbortController();
    aborted.abort();
    calls.length = 0;
    await assert.rejects(() => loadWorkThemeCatalog(room, 'owner', aborted.signal), /취소/);
    assert.equal(calls.length, 0);

    // Paginate beyond the API cap and split long work lists into bounded URLs.
    works = Array.from({ length: 121 }, (_, n) => ({ id: id(200 + n), title: 'Work ' + n }));
    rows = Array.from({ length: 1205 }, (_, n) => theme(2000 + n, works[0].id));
    rows.push(...works.slice(1).map((work, n) => theme(4000 + n, work.id)));
    calls.length = 0;
    const many = await loadWorkThemeCatalog({ work_id: works[0].id, work_combination_enabled: true, combined_work_ids: works.slice(1).map(w => w.id) }, 'owner');
    assert.equal(many.themes.length, 1325);
    assert.ok(calls.filter(call => call.table === 'works').every(call => call.filters.id.length <= 50));
    assert.ok(calls.some(call => call.range?.[0] === 1000));
    calls.length = 0;
    await loadWorkThemeCatalog({ work_id: works[0].id, work_combination_enabled: true, combined_work_ids: [works[1].id] }, 'owner', undefined, works.slice(0, 2));
    assert.ok(calls.every(call => call.table === 'themes'), 'send preflight reuses the works already validated for prompt combination');
    console.log('Combined themes: all private/shared candidates, stable IDs, duplicate titles/names, period/legacy tags, fixed payloads, inactive compatibility, bounded pagination, failures, cancellation and stale-work rejection passed.');
  } finally {
    supabase.from = originalFrom;
  }
} finally {
  await server.close();
}
