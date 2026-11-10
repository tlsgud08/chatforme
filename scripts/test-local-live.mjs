// Run on the LM Studio PC only. This intentionally uses a loaded model and never loads one.
import assert from 'node:assert/strict';
const secret = process.env.GATEWAY_SECRET;
if (!secret || secret.length < 32) throw new Error('Run with the PC gateway .env file; never put credentials in CLI arguments.');
const gateway = `http://127.0.0.1:${Number(process.env.GATEWAY_PORT || 3210)}/rpc`;
const rpc = async body => {
  const res = await fetch(gateway, { method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, 'x-chatforme-user-id': '10000000-0000-0000-0000-000000000001' }, body: JSON.stringify(body) });
  const result = await res.json(); if (!res.ok) throw new Error(result.message ?? result.code); return result;
};
const { models } = await rpc({ action: 'models' });
assert(models.length > 0, 'Load an LLM in LM Studio first.');
const model = process.env.LOCAL_TEST_MODEL || models[0].id;
assert(models.some(item => item.id === model), 'LOCAL_TEST_MODEL must be an actually loaded identifier.');
const { id } = await rpc({ action: 'start', requestId: crypto.randomUUID(), request: {
  model, maxOutputTokens: 256, messages: [{ role: 'user', content: 'Reply with a short greeting.' }],
} });
try {
  for (let attempt = 0; attempt < 240; attempt++) {
    const result = await rpc({ action: 'poll', id, cursor: 0 });
    if (result.state === 'error') throw new Error(result.error.message);
    if (result.state === 'complete') {
      assert(result.delta.trim()); assert.equal(result.usage.cost, 0); assert(result.context.promptTokens > 0);
      assert(result.context.promptTokens + result.context.maxOutputTokens < result.context.contextLength);
      console.log('Live LM Studio: loaded-model discovery, SDK template/token count, completions SSE, context validation and zero cost passed.');
      process.exitCode = 0; break;
    }
    if (attempt === 239) throw new Error('Live test timed out after 4 minutes.');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
} finally { await rpc({ action: 'cancel', id }).catch(() => {}); }
