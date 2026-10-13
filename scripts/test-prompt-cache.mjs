import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const originalFetch = globalThis.fetch;
globalThis.window = { location: { origin: 'https://example.test' } };
try {
  const { cacheTurnChoices, resolvePromptCache, buildOpenRouterMessages } = await server.ssrLoadModule('/src/lib/llm/promptCache.ts');
  const { assemblePrompt } = await server.ssrLoadModule('/src/lib/prompt/assemble.ts');
  const { generate, normalizeMessages } = await server.ssrLoadModule('/src/lib/llm/index.ts');
  const row = (id, role, extra = {}) => ({ id, role, content: id, is_hidden: false, is_active_variant: true, generation_status: 'complete', ...extra });
  const rows = [row('hidden', 'user', { is_hidden: true }), row('u1', 'user'), row('a1', 'assistant'),
    row('old', 'assistant', { is_active_variant: false }), row('u2', 'user'), row('a2', 'assistant'),
    row('u3', 'user'), row('a3', 'assistant', { generation_status: 'interrupted' })];
  const model = 'google/gemini-2.5-flash';
  assert.deepEqual(cacheTurnChoices(rows, 0), [{ id: 'a1', turn: 1 }, { id: 'a2', turn: 2 }]);
  assert.deepEqual(cacheTurnChoices(rows, 1), [{ id: 'a2', turn: 2 }]);
  assert.equal(resolvePromptCache(true, model, 'a1', rows).messageId, 'a1');
  for (const id of ['missing', 'u1', 'old', 'a3']) assert.equal(resolvePromptCache(true, model, id, rows).unavailable, true);
  assert.equal(resolvePromptCache(true, model, 'a1', rows.filter((m) => m.id !== 'a1')).unavailable, true); // summary/delete/reroll
  assert.deepEqual(resolvePromptCache(false, model, 'a1', rows), { systemOnly: false, unavailable: false });
  assert.equal(resolvePromptCache(true, 'openai/gpt-test', 'a1', rows).messageId, 'a1');
  assert.equal(resolvePromptCache(true, model, null, rows).systemOnly, true);

  // Auto mode follows only completed, visible, active assistants in outgoing history.
  assert.equal(resolvePromptCache(true, model, 'a1', rows, true).messageId, 'a2');
  assert.equal(resolvePromptCache(true, model, 'missing', [...rows, row('a4', 'assistant')], true).messageId, 'a4');
  assert.equal(resolvePromptCache(true, model, null, [row('hidden', 'assistant', { is_hidden: true }), row('live', 'assistant', { generation_status: 'streaming' }), row('old', 'assistant', { is_active_variant: false }), row('u', 'user')], true).systemOnly, true);
  assert.equal(resolvePromptCache(true, model, 'a1', rows.filter((m) => m.id !== 'a2'), true).messageId, 'a1');
  assert.equal(resolvePromptCache(true, model, 'a1', [], true).systemOnly, true);
  assert.deepEqual(resolvePromptCache(false, model, 'a1', rows, true), { systemOnly: false, unavailable: false });
  assert.equal(resolvePromptCache(true, 'openai/gpt-test', 'a1', rows, true).messageId, 'a2');

  const assembled = assemblePrompt({ systemPrompt: 'platform', mainPrompt: 'story', keywordBookContents: ['dynamic'],
    history: rows.slice(1, 3).map((m) => ({ role: m.role, content: m.content, ...(m.id === 'a1' && { cacheBreakpoint: true }) })), latestUserMessage: 'new input' });
  const opts = { ...assembled, model, apiKey: 'test-key', sessionId: 'session-test', reasoning: { send: false }, maxOutputTokens: null };
  const messages = buildOpenRouterMessages(opts);
  assert.deepEqual(messages[2], { role: 'assistant', content: [{ type: 'text', text: 'a1', cache_control: { type: 'ephemeral' } }] });
  assert.equal(messages.filter((m) => m.role === 'system').length, 1);
  assert.match(messages.at(-1).content, /Active Keywords[\s\S]*new input/);
  assert.equal(JSON.stringify(messages).includes('cacheBreakpoint'), false);

  // New turns/keywords leave the exact marked prefix unchanged.
  const extended = buildOpenRouterMessages({ ...opts, systemParts: { ...opts.systemParts, keywords: 'changed keyword' },
    messages: [...opts.messages, { role: 'assistant', content: 'new answer' }, { role: 'user', content: 'next input' }] });
  assert.deepEqual(extended.slice(0, 3), messages.slice(0, 3));
  assert.equal((JSON.stringify(extended).match(/cache_control/g) ?? []).length, 1);
  // Boundary must not absorb a following same-role message during normalization.
  const normalized = normalizeMessages([{ role: 'assistant', content: 'a', cacheBreakpoint: true }, { role: 'assistant', content: 'b' }]);
  assert.equal(normalized[0].content, '(Continue)');
  assert.equal(normalized[1].content, 'a');
  assert.equal(normalized[2].content, 'b');
  const merged = normalizeMessages([{ role: 'user', content: 'a' }, { role: 'user', content: 'b', cacheBreakpoint: true }]);
  assert.equal(merged[0].cacheBreakpoint, true);
  assert.equal(merged[0].content, 'a\n\nb');
  const noNewInput = buildOpenRouterMessages({ ...opts, messages: opts.messages.slice(0, -1) });
  assert.deepEqual(noNewInput[2], messages[2]);
  assert.match(noNewInput.at(-1).content, /Active Keywords/);
  const systemOnly = buildOpenRouterMessages({ ...opts, cacheSystemOnly: true });
  assert.ok(Array.isArray(systemOnly[0].content));
  assert.equal((JSON.stringify(systemOnly).match(/cache_control/g) ?? []).length, 1);

  // OFF exactly preserves the previous string-content payload and keyword role.
  const unmarked = opts.messages.map(({ role, content }) => ({ role, content }));
  const off = buildOpenRouterMessages({ ...opts, messages: unmarked });
  assert.deepEqual(off, [{ role: 'system', content: 'platform\n\n# Main Prompt\nstory' }, ...unmarked.slice(0, -1),
    { role: 'system', content: '# Active Keywords\ndynamic' }, unmarked.at(-1)]);
  for (const otherModel of ['openai/gpt-test', 'anthropic/claude-test', 'qwen/qwen-test', 'custom/unknown']) {
    assert.deepEqual(buildOpenRouterMessages({ ...opts, model: otherModel }), messages);
    assert.deepEqual(buildOpenRouterMessages({ ...opts, model: otherModel, cacheSystemOnly: true }), systemOnly);
    assert.deepEqual(buildOpenRouterMessages({ ...opts, model: otherModel, messages: unmarked }), off);
  }

  // Exercise the real generate -> normalize -> adapter -> HTTP serialization path.
  let sent;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5000,
      completion_tokens: 1, prompt_tokens_details: { cached_tokens: 4000, cache_write_tokens: 0 }, cost: 0.001 } }), { status: 200 });
  };
  const result = await generate('openrouter', opts);
  assert.deepEqual(sent.messages, messages);
  assert.equal(result.usage.cacheReadTokens, 4000);
  assert.equal(sent.session_id, 'session-test');
  assert.equal(JSON.stringify(sent).includes('cacheBreakpoint'), false);
  await generate('openrouter', { ...opts, messages: unmarked });
  assert.deepEqual(sent.messages, off);
  // Persistent plugins must be present on consecutive HTTP requests, absent after
  // deactivation, and included inside a system-only manual cache boundary.
  const pluginA = { id: 'plugin-a', name: 'Dialogue', description: 'Style', prompt: 'PLUGIN_A_UNIQUE' };
  const pluginB = { id: 'plugin-b', name: 'Memory', description: 'Memory', prompt: 'PLUGIN_B_UNIQUE' };
  const pluginInput = { systemPrompt: 'platform', mainPrompt: 'story', userNote: 'USER_NOTE_UNIQUE',
    summary: 'summary', persona: { name: 'Player', description: 'persona' }, history: [], latestUserMessage: 'turn one' };
  const sendPlugins = async (plugins, text, cacheSystemOnly = false) => {
    const prompt = assemblePrompt({ ...pluginInput, plugins, latestUserMessage: text });
    await generate('openrouter', { ...opts, ...prompt, cacheSystemOnly });
    return JSON.stringify(sent.messages);
  };
  for (const text of ['turn one', 'turn two']) {
    const body = await sendPlugins([pluginA, pluginB], text);
    assert.ok(body.includes('PLUGIN_A_UNIQUE') && body.includes('PLUGIN_B_UNIQUE'));
    assert.ok(body.includes('USER_NOTE_UNIQUE'));
    assert.ok(body.includes('# session prompts'));
    assert.ok(!body.includes('Active Plugins'));
    assert.equal(body.split('PLUGIN_A_UNIQUE').length - 1, 1);
  }
  const oneActive = await sendPlugins([pluginB], 'turn three');
  assert.ok(!oneActive.includes('PLUGIN_A_UNIQUE') && oneActive.includes('PLUGIN_B_UNIQUE'));
  const noneActive = await sendPlugins([], 'turn four');
  assert.ok(!noneActive.includes('PLUGIN_A_UNIQUE') && !noneActive.includes('PLUGIN_B_UNIQUE'));
  await sendPlugins([pluginA], 'turn five', true);
  assert.ok(sent.messages[0].content[0].text.includes('PLUGIN_A_UNIQUE'));
  assert.deepEqual(sent.messages[0].content[0].cache_control, { type: 'ephemeral' });
  const autoHistory = rows.slice(1, 6);
  const autoBoundary = resolvePromptCache(true, model, 'a1', autoHistory, true);
  const autoPrompt = assemblePrompt({ systemPrompt: 'platform', mainPrompt: 'story', history: autoHistory.map((m) => ({ ...m, cacheBreakpoint: m.id === autoBoundary.messageId })), latestUserMessage: 'new current input' });
  await generate('openrouter', { ...opts, ...autoPrompt, cacheSystemOnly: autoBoundary.systemOnly });
  const marked = sent.messages.filter((m) => Array.isArray(m.content));
  assert.equal(marked.length, 1);
  assert.equal(marked[0].role, 'assistant');
  assert.equal(marked[0].content[0].text, 'a2');
  assert.equal(sent.messages.at(-1).content, 'new current input');
  const disabled = resolvePromptCache(false, model, 'a1', autoHistory, true);
  const disabledPrompt = assemblePrompt({ systemPrompt: 'platform', mainPrompt: 'story', history: autoHistory.map((m) => ({ ...m, cacheBreakpoint: m.id === disabled.messageId })), latestUserMessage: 'off input' });
  await generate('openrouter', { ...opts, ...disabledPrompt, cacheSystemOnly: disabled.systemOnly });
  assert.equal(JSON.stringify(sent).includes('cache_control'), false);
  console.log('Automatic latest cache tests passed (latest boundary, invalid history, OFF payload)');
  console.log('Persistent plugin request tests passed (consecutive sends, deactivation, user notes, manual cache)');
  console.log('Manual prompt cache tests passed (boundaries, lifecycle, normalization, actual request body)');
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
}
