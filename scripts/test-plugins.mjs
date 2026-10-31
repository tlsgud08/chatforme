import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';

function makePlugins(count, long = false) {
  return Array.from({ length: count }, (_, index) => ({
    id: `plugin-${index}`,
    // Repeated names must not cause distinct plugins to be merged.
    name: index < 2 ? '동일한 이름' : `플러그인 ${index}`,
    description: `설명 ${index}`,
    prompt: `BEGIN_PLUGIN_${index}::\n한글·日本語·🙂 "quote" \\slash\n${long ? '긴 플러그인 내용과 줄바꿈을 보존합니다.\n'.repeat(500) : '짧은 지침'}\n::END_PLUGIN_${index}`,
  }));
}

function assertPlugins(body, active, removed = []) {
  const messages = body.messages.map(message => ({ ...message,
    text: typeof message.content === 'string' ? message.content : message.content.map(part => part.text).join(''),
  }));
  const system = messages.filter(message => message.role === 'system').map(message => message.text).join('\n');
  const all = messages.map(message => message.text).join('\n');
  let previous = -1;
  for (const plugin of active) {
    assert.ok(system.includes(plugin.prompt), `${plugin.id}: complete prompt reaches the system message`);
    assert.equal(all.split(plugin.prompt).length - 1, 1, `${plugin.id}: no duplication`);
    const position = system.indexOf(plugin.prompt);
    assert.ok(position > previous, `${plugin.id}: activation order preserved`);
    previous = position;
  }
  for (const plugin of removed) assert.ok(!all.includes(plugin.prompt), `${plugin.id}: deactivated prompt absent`);
  assert.ok(system.includes('PERSISTENT_USER_NOTE'), 'user notes survive alongside many plugins');
}

const cases = [3, 10, 30, 100].map(count => ({ count, long: false })).concat({ count: 30, long: true });
const modes = ['off', 'system', 'latest'];
// Reuse the existing real ChatPage.send VM environment and HTTP adapter fixture.
// Stop before its reroll-specific assertions; no application code is replaced.
const harness = readFileSync(new URL('./test-reroll.mjs', import.meta.url), 'utf8');
const boundary = harness.indexOf("  const legacy = 'original input");
assert.ok(boundary > 0, 'normal-chat fixture setup boundary exists');
const fixture = new URL(`./.plugin-fixture-${crypto.randomUUID()}.mjs`, import.meta.url);
const normalTests = `
  ${makePlugins.toString()}
  ${assertPlugins.toString()}
  const { applyKnowledge, emptyState } = await server.ssrLoadModule('/src/lib/knowledge/core.ts');
  const { DEFAULT_KNOWLEDGE_CONFIG } = await server.ssrLoadModule('/src/lib/knowledge/types.ts');
  Object.assign(env, { applyKnowledge, startConfig: null,
    prepareKnowledge: async () => ({ state: emptyState(), config: { ...DEFAULT_KNOWLEDGE_CONFIG, mainPrompt: 'KNOWLEDGE_RULE_SENTINEL' } }),
    queueKnowledge: async () => {}, messageReadControllerRef: { current: new AbortController() },
  });
  const cases = ${JSON.stringify(cases)}, modes = ${JSON.stringify(modes)};
  let requests = 0;
  for (const test of cases) for (const mode of modes) {
    const plugins = makePlugins(test.count, test.long);
    session.active_plugins = plugins;
    session.user_note = 'PERSISTENT_USER_NOTE';
    session.prompt_cache_enabled = mode !== 'off';
    session.prompt_cache_auto_latest = mode === 'latest';
    session.prompt_cache_message_id = null;
    semiContext = null;
    for (const [repeat, options] of [undefined, undefined, { reroll: true }, undefined].entries()) {
      if (repeat === 3) semiContext = { prompt: 'PEER_CONTEXT', peer_persona: { name: 'Peer', description: 'peer persona' }, peer: null };
      const before = bodies.length;
      await send(options);
      assert.equal(bodies.length, before + 1, JSON.stringify({test,mode,errors}));
      assertPlugins(bodies.at(-1), plugins);
      const marked = bodies.at(-1).messages.filter(m => Array.isArray(m.content));
      assert.equal(marked.length, mode === 'off' ? 0 : 1);
      if (mode === 'system') assert.equal(marked[0].role, 'system');
      if (mode === 'latest') assert.equal(marked[0].role, 'assistant');
      requests++;
    }
    session.knowledge_enabled = true;
    const beforeKnowledge = bodies.length;
    await send(); requests++;
    assert.equal(bodies.length, beforeKnowledge + 1);
    assertPlugins(bodies.at(-1), plugins);
    assert.ok(JSON.stringify(bodies.at(-1).messages).includes('KNOWLEDGE_RULE_SENTINEL'));
    session.knowledge_enabled = false;
    const middle = Math.floor(plugins.length / 2);
    session.active_plugins = plugins.filter((_, index) => index !== middle);
    await send(); requests++;
    assertPlugins(bodies.at(-1), session.active_plugins, [plugins[middle]]);
    session.active_plugins = [];
    await send(); requests++;
    assertPlugins(bodies.at(-1), [], plugins);
  }
  assert.deepEqual(errors, []);
  console.log('Normal chat: ' + requests + ' real send/reroll HTTP requests passed (3/10/30/100 plugins, 30 long prompts, repeated sends, peer context, information management ON/OFF, all cache modes, middle/all deactivation).');
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.window; delete globalThis.sessionStorage;
  await server.close();
}
`;
try {
  writeFileSync(fixture, harness.slice(0, boundary) + normalTests);
  process.stdout.write(execFileSync(process.execPath, [fixture.pathname], { encoding: 'utf8', maxBuffer: 2_000_000 }));
} finally { try { unlinkSync(fixture); } catch {} }

// Run the real multichat DB-reader -> prompt preparation -> OpenRouter HTTP path.
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const originalFetch = globalThis.fetch;
globalThis.window = { location: { origin: 'https://plugins.test' } };
try {
  const { supabase } = await server.ssrLoadModule('/src/lib/supabase.ts');
  const { prepareMultichatContext } = await server.ssrLoadModule('/src/lib/multichatContext.ts');
  const { generate } = await server.ssrLoadModule('/src/lib/llm/index.ts');
  const { applyKnowledge, emptyState } = await server.ssrLoadModule('/src/lib/knowledge/core.ts');
  const { DEFAULT_KNOWLEDGE_CONFIG } = await server.ssrLoadModule('/src/lib/knowledge/types.ts');
  let sent, requests = 0, largestBytes = 0;
  const session = { id: 'room', user_id: 'owner', work_id: 'work', summary: '', summary_last_turn: 0, active_plugins: [], theme_override: 'dark' };
  const profile = { default_model: 'fixture/model', default_reasoning: { send: false }, default_output_tokens: 256 };
  const members = [1, 2].map(slot => ({ slot, user_note: 'PERSISTENT_USER_NOTE', personas: { name: slot === 1 ? '누리' : '소희', description: `PERSONA_${slot}` } }));
  const transcript = [
    { id: 'u1', role: 'user', content: '누리(PC1): 이전 행동', turn_index: 1 },
    { id: 'a1', role: 'assistant', content: '이전 이야기', turn_index: 1 },
    { id: 'u2', role: 'user', content: '소희(PC2): 현재 행동', turn_index: 2 },
  ].map(row => ({ ...row, is_active_variant: true, is_hidden: false, generation_status: 'complete' }));
  supabase.from = table => {
    const query = {
      select() { return this; }, eq() { return this; }, in() { return this; }, order() { return this; }, range() { return this; },
      single() { return this; },
      then(resolve, reject) {
        const data = ({ sessions: structuredClone(session), platform_config: { system_prompt: 'PLATFORM', multichat_system_prompt: 'MULTI_RULES', theme_prompt: '' },
          multichat_members: members, messages: transcript, works: { id: 'work', main_prompt: 'WORLD', multichat_prompt: 'MULTI_WORLD' },
          story_notes: [{ content: 'STORY_NOTE' }], themes: [], keyword_books: [],
        })[table];
        assert.notEqual(data, undefined, `expected table ${table}`);
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return query;
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    sent = JSON.parse(options.body); requests++;
    largestBytes = Math.max(largestBytes, Buffer.byteLength(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  };
  for (const test of cases) for (const mode of modes) for (const progressMode of ['together', 'solo']) {
    const plugins = makePlugins(test.count, test.long);
    session.active_plugins = plugins;
    session.prompt_cache_enabled = mode !== 'off';
    session.prompt_cache_auto_latest = mode === 'latest';
    session.prompt_cache_message_id = null;
    const send = async () => {
      const prepared = await prepareMultichatContext('room', 2, profile, { progressMode, activeSlot: progressMode === 'solo' ? 2 : null });
      prepared.assembled = applyKnowledge(prepared.assembled, session.knowledge_enabled === true,
        { ...DEFAULT_KNOWLEDGE_CONFIG, mainPrompt: 'KNOWLEDGE_RULE_SENTINEL' }, emptyState());
      await generate('openrouter', { apiKey: 'fixture', sessionId: 'room', model: prepared.model, reasoning: prepared.reasoning,
        maxOutputTokens: prepared.maxOutputTokens, ...prepared.assembled, cacheSystemOnly: prepared.cacheSystemOnly });
      return sent;
    };
    for (let repeat = 0; repeat < 2; repeat++) {
      const body = await send();
      assertPlugins(body, plugins);
      const marked = body.messages.filter(m => Array.isArray(m.content));
      assert.equal(marked.length, mode === 'off' ? 0 : 1);
      if (mode !== 'off') assert.equal(marked[0].role, mode === 'system' ? 'system' : 'assistant');
      assert.ok(JSON.stringify(body.messages).includes('PERSONA_1'));
      assert.ok(JSON.stringify(body.messages).includes('PERSONA_2'));
    }
    session.knowledge_enabled = true;
    assertPlugins(await send(), plugins);
    assert.ok(JSON.stringify(sent.messages).includes('KNOWLEDGE_RULE_SENTINEL'));
    session.knowledge_enabled = false;
    const middle = Math.floor(plugins.length / 2);
    session.active_plugins = plugins.filter((_, index) => index !== middle);
    assertPlugins(await send(), session.active_plugins, [plugins[middle]]);
    session.active_plugins = [];
    assertPlugins(await send(), [], plugins);
  }
  console.log(`Multichat: ${requests} real context/HTTP requests passed (same plugin sizes, shared/solo PC2, information management ON/OFF, all cache modes, repeated sends and deactivation). Largest request: ${largestBytes} bytes.`);
  console.log('No paid model calls: HTTP responses and DB rows were fixtures; production prompt/adapter code ran unchanged.');
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.window;
  await server.close();
}
