import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fixture, OWNER, OTHER, SECRET, frame } from './local-gateway-fixture.mjs';

process.env.VITE_SUPABASE_URL = 'https://local-provider.test';
process.env.VITE_SUPABASE_ANON_KEY = 'public-fixture';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const savedFetch = globalThis.fetch, savedWindow = globalThis.window, savedStorage = globalThis.localStorage;
globalThis.window = { location: { origin: 'https://app.fixture' }, dispatchEvent() {} };
const storage = new Map(); globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
const f = await fixture();
try {
  const { createLocalProxy } = await server.ssrLoadModule('/supabase/functions/local-llm/handler.ts');
  const env = { SUPABASE_URL: 'https://auth.fixture', SUPABASE_ANON_KEY: 'public-fixture', LOCAL_ALLOWED_ORIGINS: 'https://app.fixture',
    LOCAL_ALLOWED_USER_IDS: OWNER, LOCAL_GATEWAY_URL: 'https://tunnel.fixture', LOCAL_GATEWAY_SECRET: SECRET };
  const requests = [];
  let gatewayTarget = f.url;
  const proxyFetch = async (url, init) => {
    if (String(url) === 'https://auth.fixture/auth/v1/user') {
      assert.equal(init.headers.apikey, 'public-fixture');
      return new Response(JSON.stringify(init.headers.authorization === 'Bearer valid-user' ? { id: OWNER } : { id: OTHER }));
    }
    assert.equal(String(url), 'https://tunnel.fixture/rpc');
    assert.equal(init.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(init.headers['x-chatforme-user-id'], OWNER); assert.equal(init.redirect, 'error');
    requests.push(JSON.parse(init.body));
    return savedFetch(gatewayTarget, init);
  };
  const proxy = createLocalProxy(name => env[name], proxyFetch);
  const proxyRequest = (input, token = 'valid-user', origin = 'https://app.fixture') => proxy(new Request('https://local-provider.test/functions/v1/local-llm', {
    method: 'POST', headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) }));
  assert.equal((await proxyRequest({ action: 'models' }, 'valid-user', 'https://evil.fixture')).status, 403);
  assert.equal((await proxyRequest({ action: 'models' }, 'other-user')).status, 403);
  assert.equal(requests.length, 0, 'denied calls cannot access the PC');
  const preflight = await proxy(new Request('https://local-provider.test/functions/v1/local-llm', { method: 'OPTIONS', headers: { origin: 'https://app.fixture' } }));
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.fixture');
  assert.equal((await proxyRequest({ action: 'fetch', url: 'http://169.254.169.254' })).status, 400);
  const authFailure = createLocalProxy(name => env[name], async () => new Response('{}', { status: 401 }));
  assert.equal((await authFailure(new Request('https://proxy.fixture', { method: 'POST', headers: { origin: 'https://app.fixture', authorization: 'Bearer expired' }, body: '{}' }))).status, 401);
  const badGateway = createLocalProxy(name => env[name], async (url, init) => String(url).includes('auth.fixture') ? proxyFetch(url, init)
    : new Response('<html>https://PRIVATE-PC SECRET ' + SECRET + '</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
  const offline = await badGateway(new Request('https://proxy.fixture', { method: 'POST', headers: { origin: 'https://app.fixture', authorization: 'Bearer valid-user' }, body: '{"action":"models"}' }));
  assert.equal(offline.status, 503); const offlineText = await offline.text(); assert(!offlineText.includes(SECRET)); assert(!offlineText.includes('PRIVATE-PC'));
  const insecure = createLocalProxy(name => name === 'LOCAL_GATEWAY_URL' ? 'http://tunnel.fixture' : env[name], proxyFetch);
  const insecureRes = await insecure(new Request('https://proxy.fixture', { method: 'POST', headers: { origin: 'https://app.fixture', authorization: 'Bearer valid-user' }, body: '{"action":"models"}' }));
  assert.equal(insecureRes.status, 503); assert.equal((await insecureRes.json()).code, 'LOCAL_NOT_CONFIGURED');

  const { supabase } = await server.ssrLoadModule('/src/lib/supabase.ts');
  supabase.auth.getSession = async () => ({ data: { session: { access_token: 'valid-user' } }, error: null });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://local-provider.test/functions/v1/local-llm');
    assert.equal(init.headers.authorization, 'Bearer valid-user');
    assert(!JSON.stringify(init).includes(SECRET)); assert(!JSON.stringify(init).includes('NEVER_SEND_OPENROUTER_KEY'));
    return proxyRequest(JSON.parse(init.body));
  };
  const { generate } = await server.ssrLoadModule('/src/lib/llm/index.ts');
  const { buildLocalMessages, createLocalAdapter } = await server.ssrLoadModule('/src/lib/llm/local.ts');
  const { discoverLocalModels } = await server.ssrLoadModule('/src/lib/llm/localTransport.ts');
  const preferences = await server.ssrLoadModule('/src/lib/localPreferences.ts');
  const { generateSummaryResponse, SUMMARY_USER_STOP } = await server.ssrLoadModule('/src/lib/summaryGeneration.ts');
  assert.equal((await discoverLocalModels()).models[0].contextLength, 131072);
  const options = { apiKey: 'NEVER_SEND_OPENROUTER_KEY', model: 'fixture/local', sessionId: 'session-fixture', maxOutputTokens: 256,
    reasoning: { effort: 'high' }, sampling: { temperature: 1, temperatureSend: true, frequencyPenalty: 0.2, frequencyPenaltySend: true, topP: 0.9, topPSend: true },
    systemParts: { core: 'SYSTEM', persona: 'PERSONA', userNote: 'USER NOTE', summary: 'SUMMARY', storyNotes: 'STORY', keywords: 'DYNAMIC' },
    messages: [{ role: 'user', content: 'history' }, { role: 'assistant', content: 'answer', cacheBreakpoint: true }, { role: 'user', content: 'current' }], cacheSystemOnly: true };
  const previews = [], phases = [];
  const result = await generate('local', { ...options, onChunk: text => previews.push(text), onPhase: phase => phases.push(phase) });
  assert.equal(result.text, '안녕🙂'); assert.equal(result.usage.cost, 0); assert.equal(previews.at(-1), result.text);
  assert(phases.includes('model-reasoning')); assert(phases.includes('model-complete'));
  const wire = f.received.at(-1);
  assert.equal(wire.messages[0].content, 'SYSTEM\n\nPERSONA\n\nUSER NOTE\n\nSUMMARY\n\nSTORY');
  assert.equal(wire.messages.at(-1).content, 'DYNAMIC\n\ncurrent');
  assert(!JSON.stringify(wire).includes('cache_control')); assert(!JSON.stringify(wire).includes('cacheBreakpoint')); assert(!JSON.stringify(wire).includes('reasoning'));
  const first = buildLocalMessages(options);
  const next = buildLocalMessages({ ...options, systemParts: { ...options.systemParts, keywords: 'NEW DYNAMIC' }, messages: [...options.messages, { role: 'assistant', content: 'new answer' }, { role: 'user', content: 'next' }] });
  assert.deepEqual(next.slice(0, 3), first.slice(0, 3), 'unchanged system/history prefix remains byte-identical');
  assert.equal(buildLocalMessages({ ...options, messages: options.messages.slice(0, -1) }).at(-2).role, 'assistant', 'continuation retains final assistant');
  const summary = await generateSummaryResponse(generate, { ...options, onChunk() {} }, 'local');
  assert.equal(summary.usage.cost, 0); assert.equal(summary.text, '안녕🙂');

  const abort = new AbortController(), actions = [];
  const cancelAdapter = createLocalAdapter(async input => {
    actions.push(input.action);
    if (input.action === 'start') return { id: 'fixture-job' };
    if (input.action === 'poll') { abort.abort(SUMMARY_USER_STOP); return { state: 'running', delta: 'LATE', cursor: 4, usage: { cost: 100 }, headers: true }; }
    return { cancelled: true };
  });
  const stopped = await generateSummaryResponse((_p, opts) => cancelAdapter.generate(opts), { ...options, signal: abort.signal }, 'local');
  assert.equal(stopped.text, ''); assert.equal(stopped.finishReason, 'user_stop'); assert(actions.includes('cancel'));
  const already = new AbortController(); already.abort(); let calls = 0;
  await assert.rejects(createLocalAdapter(async () => { calls++; }).generate({ ...options, signal: already.signal })); assert.equal(calls, 0);

  const knowledgeFixture = await fixture({ respond: res => res.end(frame({ choices: [{ delta: { content: '```json\n{"facts":[]}\n```' }, finish_reason: 'stop' }] }) + frame('[DONE]')) });
  try {
    gatewayTarget = knowledgeFixture.url;
    const accounting = [];
    supabase.rpc = async (name, args) => { accounting.push({ name, args }); return { error: null }; };
    const { structured, needsKnowledgeUpdate } = await server.ssrLoadModule('/src/lib/knowledge/model.ts');
    const modelOptions = { apiKey: '', model: 'OR_ONLY_MODEL', localModel: 'fixture/local', sessionId: 'session-fixture', signal: new AbortController().signal };
    const beforeDetector = requests.length;
    assert.equal(await needsKnowledgeUpdate(modelOptions, 'detector', {}), true);
    assert.equal(requests.length, beforeDetector, 'Local never calls paid OpenRouter Jev');
    assert.deepEqual(await structured(modelOptions, 'Record facts', {}, { type: 'object' }), { facts: [] });
    assert.equal(accounting[0].name, 'record_knowledge_call'); assert.equal(accounting[0].args.call_cost, 0); assert.equal(accounting[0].args.model_name, 'fixture/local');
    assert.equal(knowledgeFixture.received[0].model, 'fixture/local'); assert(!('response_format' in knowledgeFixture.received[0]));
  } finally { gatewayTarget = f.url; await knowledgeFixture.close(); }

  storage.set('chatforme.apiKeys', JSON.stringify({ openrouter: 'PRESERVE_KEY' }));
  preferences.saveLocalPreferences(OWNER, { provider: 'local', model: 'local-a' });
  assert.equal(preferences.summaryProviderFor(OWNER), 'local', 'old preferences follow conversation provider');
  preferences.saveLocalPreferences(OWNER, { summaryProvider: 'openrouter' });
  assert.equal(preferences.summaryProviderFor(OWNER, 's1'), 'openrouter');
  assert.equal(preferences.loadLocalPreferences(OWNER).provider, 'local', 'cloud summary leaves local conversation selected');
  preferences.saveLocalPreferences(OWNER, { sessionSummaryProviders: { s1: 'local', s2: 'default' } });
  assert.equal(preferences.summaryProviderFor(OWNER, 's1'), 'local');
  assert.equal(preferences.summaryProviderFor(OWNER, 's2'), 'openrouter');
  assert.equal(preferences.summaryProviderFor(OTHER, 's1'), 'openrouter', 'summary provider is account isolated');
  preferences.saveLocalPreferences(OWNER, { provider: 'openrouter', summaryProvider: 'local' });
  assert.equal(preferences.summaryProviderFor(OWNER, 's2'), 'local', 'local summary also works with cloud conversation');
  preferences.saveLocalPreferences(OWNER, { provider: 'local', summaryProvider: 'default', sessionSummaryProviders: {} });
  preferences.saveLocalSessionModel(OWNER, 's1', 'local-b');
  assert.equal(preferences.localModelFor(OWNER, 's1'), 'local-b'); assert.equal(preferences.localModelFor(OWNER, 's2'), 'local-a');
  assert.equal(preferences.loadLocalPreferences(OTHER).provider, 'openrouter');
  preferences.saveLocalPreferences(OWNER, { provider: 'openrouter' });
  assert.equal(preferences.localModelFor(OWNER, 's1'), 'local-b'); assert.equal(JSON.parse(storage.get('chatforme.apiKeys')).openrouter, 'PRESERVE_KEY');
  assert(!JSON.stringify([...storage.values()]).includes(SECRET));
  console.log('Local provider: real adapter → auth proxy → HTTP gateway → mock LM Studio SSE passed; model discovery, stable prefix, isolated settings, auth/CORS/HTTPS, redaction, summary/cancel/zero billing passed.');
} finally {
  globalThis.fetch = savedFetch; globalThis.window = savedWindow; globalThis.localStorage = savedStorage;
  await f.close(); await server.close();
}
