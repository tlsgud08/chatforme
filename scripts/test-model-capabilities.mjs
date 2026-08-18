import assert from 'node:assert/strict';
import { createServer } from 'vite';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
};

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const registry = await server.ssrLoadModule('/src/lib/llm/modelCapabilities.ts');
  const payloads = await server.ssrLoadModule('/src/lib/llm/reasoningPayloads.ts');

  const gpt = registry.capabilitiesFor('openrouter', 'openai/gpt-5.6-sol');
  assert.equal(gpt.provider, 'openrouter');
  assert.deepEqual(gpt.supportedEfforts, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(registry.defaultReasoningFor('openrouter', gpt.modelId), { effort: 'medium' });
  assert.deepEqual(
    payloads.openRouterReasoningPayload(gpt.modelId, { effort: 'high' }),
    { reasoning: { effort: 'high' } },
  );

  assert.throws(
    () => payloads.openRouterReasoningPayload('google/gemini-3.7-flash', { effort: 'minimal' }),
    /지원하지 않습니다/,
  );
  assert.deepEqual(payloads.openRouterReasoningPayload('custom/unknown-model', {}), {});

  localStorage.setItem('inuchat.openrouter.modelCatalog', JSON.stringify([
    { id: 'vendor/reasoning-model', name: 'Reasoning Model', supportedParameters: ['reasoning'] },
    { id: 'vendor/plain-model', name: 'Plain Model', supportedParameters: [] },
  ]));
  assert.deepEqual(registry.capabilitiesFor('openrouter', 'vendor/reasoning-model').supportedEfforts, ['low', 'medium', 'high']);
  assert.equal(registry.capabilitiesFor('openrouter', 'vendor/plain-model').reasoningKind, 'none');
  assert.throws(() => payloads.openRouterReasoningPayload('vendor/reasoning-model', { effort: 'max' }), /지원하지 않습니다/);
  console.log('OpenRouter-only model capability tests passed');
} finally {
  await server.close();
}
