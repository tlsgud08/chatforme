import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Reuse the same real ChatPage.send VM as the existing OpenRouter reroll tests.
const harness = readFileSync(new URL('./test-reroll.mjs', import.meta.url), 'utf8');
const boundary = harness.indexOf("  const legacy = 'original input");
assert(boundary > 0);
const path = new URL(`./.local-chat-fixture-${crypto.randomUUID()}.mjs`, import.meta.url);
const checks = `
  globalThis.fetch = originalFetch;
  const { fixture } = await import('./local-gateway-fixture.mjs');
  const f = await fixture();
  try {
    const { createLocalAdapter } = await server.ssrLoadModule('/src/lib/llm/local.ts');
    const adapter = createLocalAdapter(async input => {
      const result = await f.rpc(input);
      if (result.status !== 200) throw Error(result.message);
      return result;
    });
    let selectedModel = 'fixture/local';
    env.loadLocalPreferences = () => ({ provider: 'local', topP: 0.8 });
    env.localModelFor = () => selectedModel;
    env.getApiKey = () => '';
    env.generate = async (provider, opts) => { assert.equal(provider, 'local'); return adapter.generate(opts); };
    const before = JSON.stringify(history);
    await send({ reroll: true, rerollDirection: 'LOCAL_ONLY_DIRECTION' });
    assert.equal(f.received.length, 1);
    const begin = saved.find(([kind]) => kind === 'begin')[1];
    assert.equal(begin.requested_turn, 2); assert.equal(begin.requested_variant, 2); assert.equal(begin.user_message_id, null);
    assert.equal(begin.reroll_message, 'ai2');
    assert.equal(f.received[0].messages.at(-1).role, 'user');
    assert(f.received[0].messages.at(-1).content.endsWith('LOCAL_ONLY_DIRECTION'));
    assert.equal(JSON.stringify(f.received[0].messages).split('original input').length - 1, 1);
    assert(!JSON.stringify(saved).includes('LOCAL_ONLY_DIRECTION'));
    assert.equal(saved.find(([kind]) => kind === 'commit')[1].response_cost, 0);
    assert.equal(JSON.stringify(history), before); assert.equal(registry.size, 0);
    await send();
    assert.equal(saved.filter(([kind]) => kind === 'begin').at(-1)[1].requested_turn, 3);
    assert(!JSON.stringify(f.received.at(-1)).includes('LOCAL_ONLY_DIRECTION'));
    selectedModel = 'fixture/changed'; f.model.identifier = selectedModel;
    const edited = history.map(message => message.id === 'ai1' ? { ...message, content: 'EDITED PRIOR ANSWER' } : message);
    env.generationContext = async () => ({ messages: edited, summary: '', summaryLastTurn: 0, contextHash: 'edited' });
    await send({ reroll: true });
    assert.equal(f.received.at(-1).model, selectedModel);
    assert(JSON.stringify(f.received.at(-1).messages).includes('EDITED PRIOR ANSWER'));
    const generations = f.received.length;
    f.setContext(50); await send({ reroll: true });
    assert.equal(f.received.length, generations, 'overflow never starts inference');
    assert(errors.some(text => text.includes('컨텍스트 초과')));
    assert.equal(saved.filter(([kind]) => kind === 'begin').at(-1)[1].requested_turn, 2);
    assert.equal(saved.filter(([kind]) => kind === 'commit').at(-1)[1].interrupted, true);
    assert.equal(registry.size, 0); assert.equal(env.sendInFlightRef.current, false);
    assert.equal(JSON.stringify(history), before, 'no original history deletion/rewrite');
    assert.equal(bodies.length, 0, 'Local sends never invoke the existing OpenRouter fetch fixture');
    console.log('Local real chat handler: reroll same turn, next turn, one current input, direction isolation, model changes, edited history, overflow warning/cleanup and zero-cost commit passed.');
  } finally { await f.close(); }
} finally { globalThis.fetch = originalFetch; delete globalThis.window; delete globalThis.sessionStorage; await server.close(); }
`;
try {
  writeFileSync(path, harness.slice(0, boundary) + checks);
  process.stdout.write(execFileSync(process.execPath, [path.pathname], { encoding: 'utf8', maxBuffer: 2_000_000 }));
} finally { try { unlinkSync(path); } catch {} }
