// Real UI + real Local adapter/proxy/gateway; Auth/DB and LM inference are fixtures.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { OWNER, SECRET, frame } from './local-gateway-fixture.mjs';
import { managementFixture } from './model-management-fixture.mjs';

process.env.VITE_SUPABASE_URL = 'https://local-ui.test';
process.env.VITE_SUPABASE_ANON_KEY = 'fixture-public';
const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const f = await managementFixture();
let browser;
const user = { id: OWNER, email: 'local@example.test', aud: 'authenticated', role: 'authenticated' };
const sid = '20000000-0000-0000-0000-000000000001', wid = '30000000-0000-0000-0000-000000000001';
const profile = { id: OWNER, display_name: 'Local fixture', default_provider: 'openrouter', default_model: 'fixture/openrouter',
  default_reasoning: { send: false }, default_output_tokens: 256, default_temperature: 1, prefer_work_theme: false, summary_model: 'fixture/summary', favorite_models: [] };
const session = { id: sid, user_id: OWNER, work_id: wid, title: 'Local RP fixture', summary: '', summary_last_turn: 0, user_note: 'USER NOTE',
  active_plugins: [], theme_override: 'builtin', model_override: 'fixture/openrouter-room', reasoning_override: { send: false }, total_cost: 0 };
let messages = [], offline = false, claims = [], commits = [], starts = [], mutations = [], summaries = [], summaryModels = [];
try {
  const { createLocalProxy } = await server.ssrLoadModule('/supabase/functions/local-llm/handler.ts');
  const env = { SUPABASE_URL: 'https://fixture-auth.test', SUPABASE_ANON_KEY: 'fixture-public', LOCAL_ALLOWED_ORIGINS: origin,
    LOCAL_ALLOWED_USER_IDS: OWNER, LOCAL_GATEWAY_URL: 'https://fixture-tunnel.test', LOCAL_GATEWAY_SECRET: SECRET };
  const proxy = createLocalProxy(name => env[name], async (url, init) => String(url).includes('fixture-auth.test') ? new Response(JSON.stringify(user))
    : offline ? new Response('offline', { status: 502 }) : fetch(f.url, init));
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(({ user }) => {
    if (!localStorage.getItem('sb-local-ui-auth-token')) localStorage.setItem('sb-local-ui-auth-token', JSON.stringify({ access_token: 'fixture-user', refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user }));
    if (!localStorage.getItem('chatforme.apiKeys')) localStorage.setItem('chatforme.apiKeys', '{"openrouter":"PRESERVE_KEY"}');
    localStorage.setItem('inuchat.exchange.usd-krw', JSON.stringify({ rate: 1400, updatedAt: Date.now() }));
  }, { user });
  const page = await context.newPage(), errors = [], leaked = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/fixture-tunnel|127\.0\.0\.1:1234|localhost:1234/.test(request.url()) || JSON.stringify(request.headers()).includes(SECRET)) leaked.push(request.url()); });
  await context.route('https://local-ui.test/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === '/functions/v1/local-llm') {
      const input = req.postDataJSON(); if (input.action === 'start') starts.push(input);
      const response = await proxy(new Request(req.url(), { method: 'POST', headers: { ...req.headers(), origin }, body: req.postData() }));
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() }); return;
    }
    const path = url.pathname.replace('/rest/v1/', ''), single = req.headers().accept?.includes('vnd.pgrst.object');
    let data = [];
    if (req.method() === 'PATCH') mutations.push({ path, data: req.postDataJSON() });
    if (url.pathname === '/auth/v1/user') data = user;
    else if (path === 'profiles') data = single ? profile : [profile];
    else if (path === 'sessions') data = single ? session : [];
    else if (path === 'works') data = { id: wid, title: 'RP fixture', main_prompt: 'WORLD', creator_id: OWNER };
    else if (path === 'platform_config') data = { system_prompt: 'SYSTEM', theme_prompt: '', summary_prompt: 'Summarize.' };
    else if (path === 'rpc/is_settings_admin') data = false;
    else if (path === 'rpc/semi_session_context') data = null;
    else if (path === 'rpc/recover_expired_session_responses') data = 0;
    else if (path === 'rpc/session_message_page') data = { messages, hasOlder: false, oldestTurn: 1, totalUserTurns: messages.filter(m => m.role === 'user').length };
    else if (path === 'rpc/session_generation_context') data = { messages, summary: '', summaryLastTurn: 0 };
    else if (path === 'rpc/begin_session_response') {
      const input = req.postDataJSON(); claims.push(input);
      const row = { session_id: sid, created_at: new Date().toISOString(), is_hidden: false, is_active_variant: true, content_version: 0,
        turn_index: input.requested_turn, input_tokens: 0, output_tokens: 0, cost: 0, cache_read_tokens: null, cache_write_tokens: null };
      const userMessage = input.user_message_id ? { ...row, id: input.user_message_id, role: 'user', content: input.user_text, generation_status: 'complete' } : null;
      const draft = { ...row, id: input.response_id, role: 'assistant', content: '', generation_status: 'streaming', reroll_index: 1 };
      if (userMessage) messages.push(userMessage); messages.push(draft); data = { draft, userMessage };
    } else if (path === 'rpc/finish_session_response' || path === 'rpc/interrupt_session_response') {
      const input = req.postDataJSON(); commits.push(input);
      const message = { ...messages.find(m => m.id === input.target_message), content: input.response_text, generation_status: path.includes('interrupt') ? 'interrupted' : 'complete' };
      messages = messages.map(m => m.id === message.id ? message : m); data = { message, session };
    } else if (path === 'rpc/save_generated_summary') {
      const input = req.postDataJSON(); summaries.push(input); data = { ...session, summary: input.summary_text, summary_last_turn: input.through_turn };
    } else if (path === 'rpc/session_conversation_counts') data = [{ session_id: sid, conversation_count: messages.filter(m => m.role === 'user').length }];
    else if (path === 'messages') data = single ? messages[0] : messages;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await context.route('https://openrouter.ai/**', route => {
    if (route.request().url().includes('chat/completions')) {
      const input = route.request().postDataJSON(); assert.equal(input.model, 'fixture/summary', 'Only explicitly selected OpenRouter summary may call the cloud'); summaryModels.push(input);
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: frame({ choices: [{ delta: { content: 'OPENROUTER SUMMARY' }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 5, cost: 0.02 } }) + frame('[DONE]') });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(origin + '/settings');
  await page.getByRole('button', { name: 'API · 모델', exact: true }).click();
  const provider = page.getByLabel('모델 제공자', { exact: true });
  assert.equal(await provider.inputValue(), 'openrouter');
  await provider.selectOption('local');
  await page.getByLabel('기본 Local 모델', { exact: true }).selectOption('fixture/local');
  await page.getByRole('button', { name: '원격 모델 로드 · 컨텍스트', exact: true }).click();
  await page.getByLabel('다운로드된 Local 모델', { exact: true }).selectOption('fixture/second');
  await page.getByLabel('원격 로드 컨텍스트', { exact: true }).fill('65536');
  await page.getByRole('button', { name: '모델 로드', exact: true }).click();
  await page.getByRole('button', { name: '로드', exact: true }).click();
  await page.getByText(/로드 완료 · 실제 컨텍스트 65,536/).waitFor();
  await page.getByLabel('원격 모델 작업 대상', { exact: true }).selectOption('fixture/local');
  await page.getByLabel('원격 로드 컨텍스트', { exact: true }).fill('131072');
  await page.getByRole('button', { name: '컨텍스트 적용 · 재로드', exact: true }).click();
  await page.getByRole('button', { name: '재로드', exact: true }).click();
  await page.getByText(/로드 완료 · 실제 컨텍스트 131,072/).waitFor();
  assert.equal(f.active.length, 2); assert.equal(await f.active.find(m => m.identifier === 'fixture/local').getContextLength(), 131072);
  assert.equal(f.calls.filter(c => c[0] === 'unload').length, 1);
  await page.getByLabel('Local 제공자 사용 중').first().waitFor();
  await page.getByLabel('Local Top-P', { exact: true }).fill('0.85');
  await page.getByRole('button', { name: '요약 설정', exact: true }).click();
  await page.getByLabel('요약 제공자', { exact: true }).selectOption('openrouter');
  await page.getByText(/요약은 OpenRouter로 전송합니다/).waitFor();
  await page.reload(); await page.getByRole('button', { name: 'API · 모델', exact: true }).click();
  assert.equal(await page.getByLabel('기본 Local 모델', { exact: true }).inputValue(), 'fixture/local');
  await mkdir('/tmp/chatforme-artifacts', { recursive: true });
  await page.screenshot({ path: '/tmp/chatforme-artifacts/local-settings-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  offline = true; await page.getByRole('button', { name: '연결·모델 새로고침', exact: true }).first().click();
  await page.getByText(/Local 오프라인:/).first().waitFor();
  offline = false; await page.getByRole('button', { name: '연결·모델 새로고침', exact: true }).first().click();
  await page.getByText('Local 연결됨 · API 비용 0원', { exact: true }).first().waitFor();
  await page.goto(origin + '/chat/' + sid);
  const composer = page.getByLabel('메시지 입력', { exact: true }); await composer.waitFor();
  await page.waitForFunction(() => !document.querySelector('button[aria-label="세션 메뉴 열기"]')?.disabled);
  await composer.fill('첫 번째 행동'); await page.getByRole('button', { name: '메시지 전송', exact: true }).click();
  try { await page.getByText('안녕🙂', { exact: true }).waitFor({ timeout: 12_000 }); }
  catch (error) { console.log(JSON.stringify({ claims, commits, starts, errors, body: await page.locator('body').innerText() }, null, 2)); throw error; }
  await page.waitForFunction(() => !document.querySelector('button[aria-label="응답 생성 중단"]'));
  assert.equal(claims.length, 1); assert.equal(claims[0].requested_turn, 1); assert.equal(commits[0].response_cost, 0);
  assert.equal(starts[0].request.sampling.top_p, 0.85);
  assert.equal(messages.filter(m => m.role === 'user').length, 1);
  await page.reload(); await page.getByText('안녕🙂', { exact: true }).waitFor();
  assert.equal(starts.length, 1, 'reconnect reads saved messages without another generation');
  await page.screenshot({ path: '/tmp/chatforme-artifacts/local-chat-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '세션 메뉴 열기', exact: true }).click();
  await page.getByRole('tab', { name: '메모리', exact: true }).click();
  assert.equal(await page.getByLabel('이 채팅방 요약 제공자', { exact: true }).inputValue(), 'default');
  await page.getByText(/요약은 OpenRouter로 전송합니다/).waitFor();
  const summarySaved = page.waitForResponse(response => response.url().includes('/rpc/save_generated_summary') && response.status() === 200);
  await page.getByRole('button', { name: '지금 요약 노트 생성', exact: true }).click();
  await summarySaved;
  assert.equal(summaries.length, 1); assert.equal(summaries[0].response_cost, 0.02); assert.equal(summaries[0].summary_text, 'OPENROUTER SUMMARY');
  assert.equal(summaryModels.length, 1); assert.equal(starts.length, 1, 'cloud summary never starts local inference');
  await page.goto(origin + '/settings'); await page.getByRole('button', { name: 'API · 모델', exact: true }).click();
  await page.getByLabel('모델 제공자', { exact: true }).selectOption('openrouter');
  assert.equal(await page.getByLabel('Local 제공자 사용 중').count(), 0);
  assert.equal(await page.locator('input[placeholder="OpenRouter API 키 입력"]').inputValue(), 'PRESERVE_KEY');
  assert(mutations.filter(m => m.path === 'sessions').every(m => !m.data.model_override || m.data.model_override === 'fixture/openrouter-room'));
  assert.equal(session.model_override, 'fixture/openrouter-room'); assert.equal(profile.default_model, 'fixture/openrouter');
  assert.deepEqual(errors, []); assert.deepEqual(leaked, []);
  console.log('Local mobile browser: authenticated remote model load/context reload, provider/badge/offline/Top-P, Local generation and zero-cost commit, independent OpenRouter summary with actual billing, reconnect and no secret exposure passed.');
} finally { if (browser) await browser.close(); await f.close(); await server.close(); }
