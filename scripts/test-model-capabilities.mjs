import assert from 'node:assert/strict';
import { createServer } from 'vite';

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
  console.log('OpenRouter-only model capability tests passed');
} finally {
  await server.close();
}
