// Builds two real PWA versions, changes the server while a tab stays open,
// and checks routing, delayed counts, scroll and multilingual admin search.
// Every API/model request is mocked; no production data or paid model is used.
import { createServer as httpServer } from 'node:http';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { build } from 'vite';
const root = fileURLToPath(new URL('../', import.meta.url));
const base = await mkdtemp(join(tmpdir(), 'inuchat-loading-'));
const baseline = process.argv.includes('--baseline');
const label = baseline ? 'before' : 'after';
process.env.VITE_SUPABASE_URL = 'https://loading-check.test';
process.env.VITE_SUPABASE_ANON_KEY = 'mock-anon-key';
process.env.VITE_ADMIN_EMAIL = 'admin@example.test';
for (const version of ['v1', 'v2']) {
    await build({ root, configFile: root + '/vite.config.ts', logLevel: 'error', build: { outDir: base + '/' + label + '/' + version, emptyOutDir: true }, plugins: [{ name: 'deployment-fixture', transform(code, id) { if (id.endsWith('/pages/ChatPage.tsx') || id.endsWith('/pages/SessionsPage.tsx'))
                    return code + `\nconsole.info('deployment fixture ${version}');`; } }] });
}
let version = 'v1';
const failedAssets = [];
const server = httpServer(async (req, res) => {
    try {
        let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (path === '/')
            path = '/index.html';
        let file = base + '/' + label + '/' + version + path;
        try {
            if (!(await stat(file)).isFile())
                throw Error();
        }
        catch {
            if (path.startsWith('/assets/')) {
                failedAssets.push(path);
                res.writeHead(404);
                res.end('missing old asset');
                return;
            }
            file = base + '/' + label + '/' + version + '/index.html';
        }
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(body);
    }
    catch {
        res.writeHead(500);
        res.end();
    }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}), headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-zygote', '--disable-software-rasterizer'] });
const userId = '10000000-0000-0000-0000-000000000001', workId = '20000000-0000-0000-0000-000000000001', sessionId = '30000000-0000-0000-0000-000000000001';
const work = { id: workId, creator_id: userId, title: 'Test work', description: 'Description', visibility: 'public', thumbnail_url: null, main_prompt: 'story', default_theme_id: null, default_theme_variant: null };
const session = { id: sessionId, user_id: userId, work_id: workId, title: 'Test room', total_cost: 0, persona_id: null, start_config_id: null, summary: '', summary_last_turn: 0, active_plugins: [], combined_work_ids: [], work_combination_enabled: true, theme_override: 'builtin', theme_id: null, model_override: 'test/model', user_note: '', theme_variant: 'light', is_archived: false };
const profile = { id: userId, display_name: 'Tester', preferred_theme_mode: 'light', preferred_theme_variant: 'light', prefer_work_theme: false, preferred_theme_id: null, default_model: 'test/model', default_provider: 'openrouter', default_reasoning_enabled: false, default_output_tokens: 1024, default_temperature: 1 };
let messages = Array.from({ length: 16 }, (_, i) => ({ id: 'message-' + i, session_id: sessionId, role: i % 2 ? 'assistant' : 'user', content: ('Message ' + i + ' story line.\n\n').repeat(12), turn_index: 1 + Math.floor(i / 2), created_at: new Date(1700000000000 + i * 1000).toISOString(), is_hidden: false, is_active_variant: true, generation_status: 'complete', command_name: null, command_id: null, cost: 0, output_tokens: 0, input_tokens: 0, reroll_index: 1 }));
const requests = [];
let delayCounts = 0;
const errors = [];
async function setup(context) {
    await context.addInitScript(({ userId }) => { localStorage.setItem('chatforme.apiKeys', JSON.stringify({ openrouter: 'mock-only-key' })); localStorage.setItem('sb-loading-check-auth-token', JSON.stringify({ access_token: 'test-access-token', refresh_token: 'test-refresh-token', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: userId, email: 'admin@example.test', aud: 'authenticated', role: 'authenticated' } })); }, { userId });
    await context.route('https://loading-check.test/**', async (route) => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/rest/v1/', '');
        requests.push({ path, search: url.search, method: request.method(), at: Date.now() });
        const single = request.headers().accept?.includes('vnd.pgrst.object');
        let data = [];
        if (path === 'works')
            data = url.searchParams.has('title') ? [{ id: '20000000-0000-0000-0000-000000000002', title: '明治ロマン', description: 'Japanese unlisted work' }] : single ? work : [work];
        else if (path === 'sessions')
            data = single || url.searchParams.has('id') ? session : [{ ...session, works: { title: work.title, thumbnail_url: null } }];
        else if (path === 'profiles')
            data = single ? profile : [profile];
        else if (path === 'public_profiles')
            data = [{ id: userId, display_name: 'Tester' }];
        else if (path === 'platform_config')
            data = { system_prompt: '', theme_prompt: '' };
        else if (path === 'rpc/session_message_page')
            data = { messages, hasOlder: false, oldestTurn: 1, totalUserTurns: 8 };
        else if (path === 'rpc/session_generation_context')
            data = { messages, summary: '', summaryLastTurn: 0 };
        else if (path === 'rpc/finish_session_response') {
            const input = request.postDataJSON();
            const ai = { ...messages.find(m => m.id === input.target_message), content: input.response_text, generation_status: 'complete', usage_accounted: true };
            messages = messages.map(m => m.id === ai.id ? ai : m);
            data = { message: ai, session };
        }
        else if (path === 'rpc/session_conversation_counts') {
            await new Promise(resolve => setTimeout(resolve, delayCounts));
            data = [{ session_id: sessionId, conversation_count: 8 }];
        }
        else if (path === 'messages') {
            if (request.method() === 'POST') {
                const input = request.postDataJSON();
                const item = { ...messages.at(-1), ...input, id: 'message-' + messages.length, created_at: new Date().toISOString() };
                messages.push(item);
                data = item;
            }
            else if (request.method() === 'PATCH') {
                const patch = request.postDataJSON();
                const id = (url.searchParams.get('id') || '').replace('eq.', '');
                messages = messages.map(m => m.id === id ? { ...m, ...patch } : m);
                data = single ? messages.find(m => m.id === id) : [];
            }
            else
                data = messages;
        }
        else if (path.startsWith('rpc/'))
            data = [];
        await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', 'content-range': '0-0/0' }, body: request.method() === 'HEAD' ? '' : JSON.stringify(data) });
    });
    await context.route('https://**/*', async (route) => { const url = new URL(route.request().url()); if (url.hostname === 'loading-check.test')
        return route.fallback(); if (url.pathname.endsWith('/chat/completions')) {
        const text = ('Generated AI story paragraph.\n\n').repeat(40);
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ id: 'mock-generation', choices: [{ delta: { content: text } }], usage: { prompt_tokens: 20, completion_tokens: 40, cost: 0 } }) + '\n\ndata: [DONE]\n\n' });
    } await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
}
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await setup(context);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/works');
    await page.getByText('Test work', { exact: true }).first().waitFor();
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    delayCounts = 2000;
    const start = Date.now();
    await page.getByRole('link', { name: '채팅방', exact: true }).first().click();
    await page.locator('.session-list').getByText('Test room', { exact: true }).waitFor();
    const listMs = Date.now() - start;
    await page.getByRole('link', { name: '작품', exact: true }).first().click();
    await page.getByText('Test work', { exact: true }).first().waitFor();
    const sidebarReloads = requests.filter(r => r.path === 'sessions' && r.search.includes('limit=8')).length;
    // The previous build remains open while the server and worker update.
    version = 'v2';
    const workerState = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); const old = r.active; await r.update(); const until = Date.now() + 15000; while (Date.now() < until) {
        if (r.waiting)
            return 'waiting';
        if (r.active !== old && r.active?.state === 'activated')
            return 'activated';
        await new Promise(resolve => setTimeout(resolve, 50));
    } return 'timeout'; });
    await page.getByRole('link', { name: '채팅방', exact: true }).first().click();
    await page.locator('.session-list').getByText('Test room', { exact: true }).waitFor();
    await page.locator('.session-list a').first().click();
    if (baseline) {
        await page.getByRole('alert').filter({ hasText: '화면을 불러오지 못했습니다' }).waitFor();
        assert.equal(workerState, 'activated');
        assert(failedAssets.some(p => p.includes('ChatPage')));
    }
    else {
        await page.locator('.chat-scroll').waitFor();
        assert.equal(workerState, 'waiting');
        assert.equal(await page.getByRole('alert').count(), 0);
        assert(listMs < 1200, 'counts must not block the room list');
        assert.equal(sidebarReloads, 1, 'route changes must not refetch a fresh sidebar');
    }
    const result = { label, listMs, sidebarReloads, workerState, failedAssets, errors };
    console.log(JSON.stringify(result));
    if (!baseline) {
        const scroller = page.locator('.chat-scroll');
        await page.waitForTimeout(100);
        await scroller.evaluate(e => { e.scrollTop = e.scrollHeight - e.clientHeight - 40; });
        await page.waitForTimeout(100);
        const top = await scroller.evaluate(e => e.scrollTop);
        const message = page.locator('.chat-message').last();
        await message.getByRole('button', { name: '메시지 편집', exact: true }).click();
        await message.locator('textarea').fill(('Edited story line.\n\n').repeat(20));
        await message.getByRole('button', { name: '저장', exact: true }).click();
        await message.locator('textarea').waitFor({ state: 'hidden' });
        await page.waitForTimeout(100);
        const afterEdit = await scroller.evaluate(e => e.scrollTop);
        assert(Math.abs(afterEdit - top) < 3, `edit moved scroll ${top} -> ${afterEdit}`);
        console.log(JSON.stringify({ scrollEdit: { before: top, after: afterEdit } }));
        await scroller.evaluate(e => { e.scrollTop = 200; });
        await page.waitForTimeout(100);
        await page.getByPlaceholder('메시지 입력…').fill('Generate a test response');
        await page.getByRole('button', { name: '메시지 전송', exact: true }).click();
        await page.locator('.chat-message').last().getByText(/Generated AI story paragraph/).first().waitFor({ timeout: 15000 });
        await page.waitForFunction(() => !document.querySelector('.chat-stream'));
        await page.waitForTimeout(100);
        const afterGeneration = await scroller.evaluate(e => e.scrollTop);
        assert(Math.abs(afterGeneration - 200) < 3, `generation moved scroll 200 -> ${afterGeneration}`);
        console.log(JSON.stringify({ scrollGeneration: { before: 200, after: afterGeneration } }));
        await page.getByRole('button', { name: '세션 메뉴 열기' }).click();
        await page.getByLabel('추가할 작품 검색', { exact: true }).fill('明治ロマン');
        await page.getByText('Japanese unlisted work', { exact: true }).waitFor();
        const searchRequest = requests.findLast(r => r.path === 'works' && new URLSearchParams(r.search).has('title'));
        assert(!new URLSearchParams(searchRequest.search).has('or'), 'actual admin drawer must include unlisted titles');
        console.log(JSON.stringify({ multilingualAdminSearch: true }));
    }
    await context.close();
    if (!baseline) {
        // Legacy navigation remains usable after an actual missing route chunk.
        // Counts are optional even when the RPC fails rather than merely waits.
        const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
        await setup(mobile);
        await mobile.addInitScript(() => localStorage.setItem('inuchat.interface-design.v1', 'legacy'));
        await mobile.route('https://loading-check.test/rest/v1/rpc/session_conversation_counts', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'temporary count failure' }) }));
        await mobile.route('**/assets/SearchPage-*.js', route => route.abort());
        await mobile.route('**/assets/CreatePage-*.js', route => route.abort());
        const mobilePage = await mobile.newPage();
        await mobilePage.goto(origin + '/sessions');
        await mobilePage.locator('.session-list').getByText('Test room', { exact: true }).waitFor();
        await mobilePage.getByText('대화 수를 불러오지 못했습니다.', { exact: false }).waitFor();
        assert.equal(await mobilePage.getByText('아직 플레이한 채팅방이 없습니다.', { exact: true }).count(), 0);
        await mobilePage.getByRole('button', { name: /작품·유저 검색/ }).click();
        await mobilePage.getByRole('alert').filter({ hasText: '화면을 불러오지 못했습니다' }).waitFor();
        await mobilePage.getByRole('link', { name: '작품 목록', exact: true }).click();
        await mobilePage.getByRole('link', { name: '제작', exact: true }).click();
        await mobilePage.getByRole('alert').filter({ hasText: '화면을 불러오지 못했습니다' }).waitFor();
        await mobilePage.getByRole('link', { name: '작품', exact: true }).click();
        await mobilePage.getByRole('link', { name: 'Test work', exact: true }).last().click();
        await mobilePage.getByRole('heading', { name: 'Test work', exact: true }).waitFor();
        const detail = requests.findLast(r => r.path === 'works' && new URLSearchParams(r.search).get('id') === 'eq.' + workId);
        assert(!new URLSearchParams(detail.search).get('select').includes('*'), 'work details must not download unused prompt bodies');
        console.log(JSON.stringify({ mobileLegacyRecovery: true, optionalCountFailure: true, metadataOnlyWorkDetail: true }));
        await mobile.close();
    }
}
finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
}
