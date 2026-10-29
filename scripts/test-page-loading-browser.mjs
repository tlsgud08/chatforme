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
let delayCreators = 0, holdGenerationContext = false, releaseGenerationContext;
let failContextRequests = 0, failMessagePageRequests = 0;
let modelRequests = 0;
let editConnectionFailure = '';
let contextDelay = 0, contextFailure = false;
let createCalls = 0;
let startDelay = 0, startFailure = false;
let modelDelay = 0, nextPageSnapshotDelay = 0;
let themeDelay = 0, themeRows = [], generationSummaryTurn = 0;
let failRerollSummary = false, failRerollCommand = false;
let failFinalCommits = 0, loseBeginReply = false;
const modelPayloads = [];
let branchCalls = 0, failBranchReply = false, branchResult = null, branchDelay = 0;
messages = messages.map(message => ({ ...message, content_version: 0 }));
const errors = [];
async function setup(context) {
    await context.addInitScript(({ userId }) => { localStorage.setItem('chatforme.apiKeys', JSON.stringify({ openrouter: 'mock-only-key' })); localStorage.setItem('sb-loading-check-auth-token', JSON.stringify({ access_token: 'test-access-token', refresh_token: 'test-refresh-token', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: userId, email: 'admin@example.test', aud: 'authenticated', role: 'authenticated' } })); }, { userId });
    await context.route('https://loading-check.test/**', async (route) => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/rest/v1/', '');
        requests.push({ path, search: url.search, method: request.method(), at: Date.now() });
        if (path === 'rpc/session_generation_context' && failContextRequests-- > 0) return route.abort('failed');
        if (path === 'rpc/session_message_page' && failMessagePageRequests-- > 0) return route.abort('failed');
        const single = request.headers().accept?.includes('vnd.pgrst.object');
        let data = [];
        if (path === 'works')
            data = url.searchParams.has('title') ? [{ id: '20000000-0000-0000-0000-000000000002', title: '明治ロマン', description: 'Japanese unlisted work' }] : single ? work : [work];
        else if (path === 'sessions')
            data = branchResult && url.searchParams.get('id') === 'eq.'+branchResult.id ? branchResult : single || url.searchParams.has('id') ? session : [{ ...session, works: { title: work.title, thumbnail_url: null } }];
        else if (path === 'profiles')
            data = single ? profile : [profile];
        else if (path === 'public_profiles') {
            await new Promise(resolve => setTimeout(resolve, delayCreators));
            data = [{ id: userId, display_name: 'Tester' }];
        }
        else if (path === 'themes') {
            const snapshot = structuredClone(themeRows);
            await new Promise(resolve => setTimeout(resolve, themeDelay));
            data = snapshot;
        }
        else if (path === 'summary_versions' && failRerollSummary)
            return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({message:'summary context unavailable'})});
        else if (path === 'commands' && failRerollCommand)
            return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({message:'command context unavailable'})});
        else if (path === 'start_configs') {
            await new Promise(resolve => setTimeout(resolve, startDelay));
            if (startFailure) return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({message:'start settings unavailable'})});
            data = [{id:'opening-config',work_id:workId,name:'Opening',is_default:true,initial_message:'Opening story',initial_context:'Opening context',keep_turns:5}];
        }
        else if (path === 'platform_config') {
            await new Promise(resolve => setTimeout(resolve, contextDelay));
            if (contextFailure) return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'42501',message:'context unavailable'})});
            data = { system_prompt: '', theme_prompt: '' };
        }
        else if (path === 'rpc/session_message_page') {
            const snapshot = structuredClone(messages), delay = nextPageSnapshotDelay;
            nextPageSnapshotDelay = 0;
            if (delay) await new Promise(resolve=>setTimeout(resolve,delay));
            data = { messages:snapshot, hasOlder: false, oldestTurn: 1, totalUserTurns: snapshot.filter(m=>m.role==='user'&&!m.is_hidden&&m.is_active_variant).length };
        }
        else if (path === 'rpc/semi_session_context') data = null;
        else if (path === 'rpc/session_generation_context') {
            if (holdGenerationContext) await new Promise(resolve => releaseGenerationContext = resolve);
            data = { messages, summary: '', summaryLastTurn: generationSummaryTurn };
        }
        else if (path === 'rpc/select_session_variant') {
            const input = request.postDataJSON();
            const inGroup = m => m.role==='assistant'&&(m.reroll_group_id??m.id)===input.target_group;
            const active = messages.find(m=>inGroup(m)&&m.is_active_variant);
            if (active?.id!==input.target_message && input.expected_active && active?.id!==input.expected_active)
                return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'40001',message:'Response selection changed'})});
            messages=messages.map(m=>inGroup(m)?{...m,reroll_group_id:input.target_group,is_active_variant:m.id===input.target_message,
                content_version:m.content_version+(m.is_active_variant!==(m.id===input.target_message)?1:0)}:m);
            data=null;
        }
        else if (path === 'rpc/mutate_session_message') {
            const input = request.postDataJSON();
            let current = messages.find(message => message.id === input.target_message);
            const edit = input.operation === 'edit';
            if (editConnectionFailure === 'before') { editConnectionFailure = ''; return route.abort('failed'); }
            if (current && !(edit && current.content === input.message_text && current.command_name === input.command_label && current.command_id === input.command_uuid)) {
                if (current.content_version !== input.expected_version || current.command_name !== input.expected_command_name || current.command_id !== input.expected_command_id) {
                    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({code:'40001',message:'changed'}) });
                }
                if (edit) {
                    current = { ...current, content: input.message_text, command_id: input.command_uuid, command_name: input.command_label, content_version: current.content_version + 1 };
                    messages = messages.map(message => message.id === current.id ? current : message);
                } else messages = messages.filter(message => message.id !== current.id);
            }
            data = { message: edit ? current : null, replacement: null, session, deleted: !edit };
            if (editConnectionFailure === 'after') { editConnectionFailure = ''; return route.abort('failed'); }
        }
        else if (path === 'rpc/create_session_with_start') { createCalls++; assert.equal(request.postDataJSON().target_config,'opening-config'); data = sessionId; }
        else if (path === 'rpc/branch_session_at_message') {
            branchCalls++;
            branchResult = {...session,id:request.postDataJSON().branch_id,title:'Test room (분기)'};
            data = branchResult.id;
            if (branchDelay) await new Promise(resolve=>setTimeout(resolve,branchDelay));
            if (failBranchReply) { failBranchReply=false; return route.abort('failed'); }
        }
        else if (path === 'rpc/recover_expired_session_responses') data = 0;
        else if (path === 'rpc/begin_session_response') {
            const input = request.postDataJSON();
            let draft = messages.find(message => message.id === input.response_id);
            let userMessage = messages.find(message => message.id === input.user_message_id) ?? null;
            const replayed = !!draft;
            if (!draft) {
                if (input.user_message_id) {
                    userMessage = { ...messages[0], id:input.user_message_id, session_id:sessionId, role:'user', content:input.user_text, turn_index:input.requested_turn,
                        command_id:input.user_command_id, command_name:input.user_command_name, command_prompt:input.user_command_prompt,
                        content_version:0, is_active_variant:true, is_hidden:false, generation_status:'complete', created_at:new Date().toISOString() };
                    messages.push(userMessage);
                }
                draft = { ...messages[0], id:input.response_id, session_id:sessionId, role:'assistant', content:'', turn_index:input.requested_turn,
                    reroll_group_id:input.reroll_message, reroll_index:input.requested_variant, is_active_variant:!input.reroll_message,
                    content_version:0, is_hidden:false, generation_status:'streaming', created_at:new Date().toISOString() };
                messages.push(draft);
            }
            data = { draft, userMessage, replayed };
            if (loseBeginReply) { loseBeginReply=false; return route.abort('failed'); }
        }
        else if (path === 'rpc/interrupt_session_response') {
            const input = request.postDataJSON();
            const ai = {...messages.find(message=>message.id===input.target_message),content:input.response_text,generation_status:'interrupted'};
            messages = messages.map(message=>message.id===ai.id?ai:message);
            data = {message:ai,session};
        }
        else if (path === 'rpc/finish_session_response') {
            if (failFinalCommits-- > 0) return route.abort('failed');
            const input = request.postDataJSON();
            const ai = { ...messages.find(m => m.id === input.target_message), content: input.response_text, generation_status: 'complete', usage_accounted: true };
            messages = messages.map(m => m.id === ai.id ? ai : m);
            data = { message: ai, session };
        }
        else if (path === 'rpc/session_conversation_counts') {
            await new Promise(resolve => setTimeout(resolve, delayCounts));
            data = [{ session_id: sessionId, conversation_count: messages.filter(m=>m.role==='user'&&!m.is_hidden&&m.is_active_variant).length }];
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
                const editing = 'command_name' in patch;
                if (editing && editConnectionFailure === 'before') { editConnectionFailure = ''; return route.abort('failed'); }
                const match = m => m.id === id && (!url.searchParams.has('content_version') || url.searchParams.get('content_version') === 'eq.' + m.content_version);
                const changed = messages.filter(match);
                messages = messages.map(m => match(m) ? { ...m, ...patch, content_version: m.content_version + (patch.content != null && patch.content !== m.content ? 1 : 0) } : m);
                if (editing && editConnectionFailure === 'after') { editConnectionFailure = ''; return route.abort('failed'); }
                data = single ? messages.find(m => m.id === id) : messages.filter(m => changed.some(c => c.id === m.id));
            }
            else {
                data = url.searchParams.has('id') ? messages.filter(m => 'eq.' + m.id === url.searchParams.get('id')) : messages;
                if (url.searchParams.get('role')==='eq.assistant') data=data.filter(m=>m.role==='assistant');
                const group=/reroll_group_id\.eq\.([^,]+)/.exec(url.searchParams.get('or')??'')?.[1];
                if (group) data=data.filter(m=>(m.reroll_group_id??m.id)===group);
            }
        }
        else if (path.startsWith('rpc/'))
            data = [];
        await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', 'content-range': '0-0/0' }, body: request.method() === 'HEAD' ? '' : JSON.stringify(data) });
    });
    await context.route('https://**/*', async (route) => { const url = new URL(route.request().url()); if (url.hostname === 'loading-check.test')
        return route.fallback(); if (url.pathname.endsWith('/chat/completions')) {
        modelRequests++;
        modelPayloads.push(route.request().postDataJSON());
        if (modelDelay) await new Promise(resolve=>setTimeout(resolve,modelDelay));
        const text = ('Generated AI story paragraph.\n\n').repeat(40);
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ id: 'mock-generation', choices: [{ delta: { content: text } }], usage: { prompt_tokens: 20, completion_tokens: 40, cost: 0 } }) + '\n\ndata: [DONE]\n\n' });
    } await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
}
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await setup(context);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    delayCreators = baseline ? 0 : 2000;
    const worksStart=Date.now();
    await page.goto(origin + '/works');
    await page.locator('.works-grid').getByText('Test work', { exact: true }).first().waitFor();
    const worksMs=Date.now()-worksStart;
    if(!baseline)assert(worksMs<1500,'work cards must not wait two seconds for author names');
    delayCreators=0;
    console.log(JSON.stringify({workListMs:worksMs,optionalAuthorDelayMs:baseline?0:2000}));
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
    if (!baseline) failMessagePageRequests = 1;
    const beforeRoomRead = requests.length;
    await page.locator('.session-list a').first().click();
    if (baseline) {
        await page.getByRole('alert').filter({ hasText: '화면을 불러오지 못했습니다' }).waitFor();
        assert.equal(workerState, 'activated');
        assert(failedAssets.some(p => p.includes('ChatPage')));
    }
    else {
        await page.locator('.chat-scroll').waitFor();
        await page.getByRole('status', { name: '앱 업데이트 안내' }).waitFor();
        await page.getByRole('status', { name: '앱 업데이트 안내' }).getByRole('button', { name: '확인', exact: true }).click();
        const pageReads = requests.slice(beforeRoomRead).filter(r => r.path === 'rpc/session_message_page');
        assert.equal(pageReads.length, 2, 'one failed message read must recover without leaving the room');
        assert(pageReads.every(r => r.method === 'GET' && !new URLSearchParams(r.search).has('before_turn')));
        assert.equal(workerState, 'waiting');
        assert.equal(await page.getByRole('alert').count(), 0);
        assert(listMs < 1200, 'counts must not block the room list');
        assert.equal(sidebarReloads, 1, 'route changes must not refetch a fresh sidebar');
        assert.equal(requests.filter(r => r.path === 'sessions' && r.method === 'PATCH').length, 0, 'opening a room must not rewrite its model settings');
    }
    const result = { label, listMs, sidebarReloads, workerState, failedAssets, errors };
    console.log(JSON.stringify(result));
    if (!baseline) {
        const scroller = page.locator('.chat-scroll');
        await page.waitForFunction(()=>!!document.querySelector('button[aria-label="메시지 전송"]')&&!document.querySelector('button[aria-label="메시지 전송"]').disabled);
        await page.waitForTimeout(100);
        await scroller.evaluate(e => { e.scrollTop = e.scrollHeight - e.clientHeight - 40; });
        await page.waitForTimeout(100);
        const top = await scroller.evaluate(e => e.scrollTop);
        const message = page.locator('.chat-message').last();
        const editStart = requests.length;
        editConnectionFailure = 'after';
        await message.getByRole('button', { name: '메시지 편집', exact: true }).click();
        const editScroll = [{stage:'clicked',top:await scroller.evaluate(e=>e.scrollTop)}];
        await message.locator('textarea').fill(('Edited story line.\n\n').repeat(20));
        editScroll.push({stage:'filled',top:await scroller.evaluate(e=>e.scrollTop)});
        await message.getByRole('button', { name: '저장', exact: true }).click();
        editScroll.push({stage:'saved',top:await scroller.evaluate(e=>e.scrollTop)});
        await message.locator('textarea').waitFor({ state: 'hidden' });
        await page.waitForTimeout(100);
        const afterEdit = await scroller.evaluate(e => e.scrollTop);
        assert(Math.abs(afterEdit - top) < 3, `edit moved scroll ${top} -> ${afterEdit}: ${JSON.stringify(editScroll)}`);
        assert.equal(requests.slice(editStart).filter(r => r.path === 'rpc/mutate_session_message').length, 2, 'a lost edit acknowledgement is recovered through an idempotent transaction');
        const secondEditStart = requests.length;
        editConnectionFailure = 'before';
        await message.getByRole('button', { name: '메시지 편집', exact: true }).click();
        await message.locator('textarea').fill(('Second edited story line.\n\n').repeat(20));
        await message.getByRole('button', { name: '저장', exact: true }).click();
        await message.locator('textarea').waitFor({ state: 'hidden' });
        assert.equal(requests.slice(secondEditStart).filter(r => r.path === 'rpc/mutate_session_message').length, 2, 'an uncommitted edit gets one guarded retry');
        console.log(JSON.stringify({ lostEditAcknowledgementRecovery: true, unsentEditRecovery: true, waitingVersionNotice: true }));
        console.log(JSON.stringify({ scrollEdit: { before: top, after: afterEdit } }));
        await scroller.evaluate(e => { e.scrollTop = 200; });
        await page.waitForTimeout(100);
        await page.getByPlaceholder('메시지 입력…').fill('Generate a test response');
        failContextRequests = 1;
        const beforeGenerationRead = requests.length;
        const rowsBeforeGeneration = messages.length;
        const modelsBefore = modelRequests;
        await page.getByRole('button', { name: '메시지 전송', exact: true }).click();
        await page.locator('.chat-message').last().getByText(/Generated AI story paragraph/).first().waitFor({ timeout: 15000 });
        await page.waitForFunction(() => !document.querySelector('.chat-stream'));
        await page.waitForTimeout(100);
        const afterGeneration = await scroller.evaluate(e => e.scrollTop);
        const sendRequests = requests.slice(beforeGenerationRead);
        assert.equal(sendRequests.filter(r => r.path === 'rpc/session_generation_context').length, 2);
        assert(sendRequests.filter(r => r.path === 'rpc/session_generation_context').every(r => r.method === 'GET'));
        assert.equal(sendRequests.filter(r => r.path === 'rpc/begin_session_response').length, 1, 'one atomic user/assistant claim');
        assert.equal(sendRequests.filter(r => r.path === 'messages' && r.method === 'POST').length, 0, 'turn creation has no client partial writes');
        assert.equal(messages.length, rowsBeforeGeneration + 2, 'exactly one user row and one assistant row');
        assert.equal(modelRequests - modelsBefore, 1, 'a recovered context read must call the model exactly once');
        assert(Math.abs(afterGeneration - 200) < 3, `generation moved scroll 200 -> ${afterGeneration}`);
        console.log(JSON.stringify({ scrollGeneration: { before: 200, after: afterGeneration } }));
        // Exhausted read retries must restore the draft, release the send lock,
        // and leave persisted messages/model billing untouched.
        failContextRequests = 20;
        const beforeOutage = requests.length, paidBeforeOutage = modelRequests;
        await page.getByPlaceholder('메시지 입력…').fill('Keep this draft after an outage');
        await page.getByRole('button', { name: '메시지 전송', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('textarea[aria-label="메시지 입력"]')?.value === 'Keep this draft after an outage', undefined, { timeout: 15000 });
        await page.getByRole('button', { name: '메시지 전송', exact: true }).waitFor();
        const outageRequests = requests.slice(beforeOutage);
        assert.equal(outageRequests.filter(r => r.path === 'rpc/session_generation_context').length, 4);
        assert.equal(outageRequests.filter(r => r.path === 'messages' && r.method !== 'GET').length, 0);
        assert.equal(modelRequests, paidBeforeOutage);
        failContextRequests = 0;
        console.log(JSON.stringify({ messageReadRecovery: true, contextReadRecovery: true, singleModelCall: true, boundedOutageDraftRestore: true }));
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
        const recovery = await browser.newContext({ serviceWorkers: 'block' });
        await setup(recovery);
        const recoveryPage = await recovery.newPage();
        failMessagePageRequests = 20;
        const readStart = requests.length;
        await recoveryPage.goto(origin + '/chat/' + sessionId);
        await recoveryPage.getByRole('alert').filter({ hasText: '채팅방을 불러오지 못했습니다' }).waitFor({ timeout: 15000 });
        assert.equal(requests.slice(readStart).filter(r => r.path === 'rpc/session_message_page').length, 4);
        failMessagePageRequests = 0;
        await recoveryPage.getByRole('button', { name: '다시 불러오기', exact: true }).click();
        await recoveryPage.locator('.chat-scroll').waitFor();
        console.log(JSON.stringify({ roomManualRecovery: true }));
        await recovery.close();
        // The core history must render before slow prompt dependencies. A failed
        // dependency keeps reading and draft entry usable, but never enables send.
        const progressive = await browser.newContext({ viewport:{width:390,height:844}, serviceWorkers:'block' });
        await setup(progressive);
        const progressivePage = await progressive.newPage();
        contextDelay = 2000; contextFailure = false;
        const displayStart = Date.now();
        await progressivePage.goto(origin + '/chat/' + sessionId);
        await progressivePage.locator('.chat-scroll').waitFor();
        const coreDisplayMs = Date.now()-displayStart;
        assert(coreDisplayMs < 1500, 'history must not wait two seconds for prompt settings');
        assert.equal(await progressivePage.getByRole('button',{name:'메시지 전송',exact:true}).isEnabled(),false);
        await progressivePage.getByPlaceholder('메시지 입력…').fill('Preserve this draft while loading');
        await progressivePage.getByRole('button',{name:'메시지 전송',exact:true}).waitFor();
        await progressivePage.waitForFunction(()=>!!document.querySelector('button[aria-label="메시지 전송"]')&&!document.querySelector('button[aria-label="메시지 전송"]').disabled);
        assert.equal(await progressivePage.getByPlaceholder('메시지 입력…').inputValue(),'Preserve this draft while loading');
        contextDelay = 0; contextFailure = true;
        await progressivePage.reload();
        await progressivePage.locator('.chat-scroll').waitFor();
        await progressivePage.getByRole('button',{name:'설정 다시 불러오기',exact:true}).waitFor();
        await progressivePage.getByPlaceholder('메시지 입력…').fill('Draft survives context retry');
        assert.equal(await progressivePage.getByRole('button',{name:'메시지 전송',exact:true}).isEnabled(),false);
        const modelsAtContextError = modelRequests;
        await progressivePage.getByPlaceholder('메시지 입력…').press('Enter');
        assert.equal(modelRequests,modelsAtContextError);
        contextFailure = false;
        const coreReadsBeforeRetry = requests.filter(r=>r.path==='rpc/session_message_page').length;
        await progressivePage.getByRole('button',{name:'설정 다시 불러오기',exact:true}).click();
        await progressivePage.waitForFunction(()=>!!document.querySelector('button[aria-label="메시지 전송"]')&&!document.querySelector('button[aria-label="메시지 전송"]').disabled);
        assert.equal(await progressivePage.getByPlaceholder('메시지 입력…').inputValue(),'Draft survives context retry');
        assert.equal(requests.filter(r=>r.path==='rpc/session_message_page').length,coreReadsBeforeRetry,'context retry must not reload history');
        console.log(JSON.stringify({progressiveHistoryMs:coreDisplayMs,promptDelayMs:2000,contextFailurePreservesHistory:true,contextRetryPreservesDraft:true}));
        await progressive.close();
        const creation = await browser.newContext({serviceWorkers:'block'});
        await setup(creation);
        const creationPage = await creation.newPage();
        startDelay = 1500;
        await creationPage.goto(origin+'/works/'+workId);
        await creationPage.getByRole('heading',{name:'Test work',exact:true}).waitFor();
        assert.equal(await creationPage.getByRole('button',{name:'새 채팅 시작',exact:true}).isEnabled(),false);
        await creationPage.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='새 채팅 시작'&&!button.disabled));
        const creationsBefore = createCalls;
        await creationPage.getByRole('button',{name:'새 채팅 시작',exact:true}).evaluate(button=>{button.click();button.click();});
        await creationPage.locator('.chat-scroll').waitFor();
        assert.equal(createCalls-creationsBefore,1,'two synchronous clicks must create exactly one room');
        startDelay = 0; startFailure = true;
        await creationPage.goto(origin+'/works/'+workId);
        await creationPage.getByRole('button',{name:'시작 설정 다시 불러오기',exact:true}).waitFor();
        assert.equal(await creationPage.getByRole('button',{name:'새 채팅 시작',exact:true}).isEnabled(),false);
        startFailure = false;
        await creationPage.getByRole('button',{name:'시작 설정 다시 불러오기',exact:true}).click();
        await creationPage.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='새 채팅 시작'&&!button.disabled));
        console.log(JSON.stringify({startSettingsRequired:true,startFailureRecovery:true,doubleClickCreatesOneRoom:true}));
        await creation.close();
        // Re-enter during a generation: an older initial-page response must not
        // overwrite the completed response that a fresh listener read first.
        const background = await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
        await setup(background);
        const backgroundPage = await background.newPage();
        await backgroundPage.goto(origin+'/chat/'+sessionId);
        await backgroundPage.waitForFunction(()=>!!document.querySelector('button[aria-label="메시지 전송"]')&&!document.querySelector('button[aria-label="메시지 전송"]').disabled);
        const modelsBeforeBackground=modelRequests;
        modelDelay=1500;
        await backgroundPage.getByPlaceholder('메시지 입력…').fill('Generation survives route changes');
        await backgroundPage.getByRole('button',{name:'메시지 전송',exact:true}).click();
        const untilModel=Date.now()+10000;
        while(modelRequests===modelsBeforeBackground&&Date.now()<untilModel)await backgroundPage.waitForTimeout(10);
        assert.equal(modelRequests,modelsBeforeBackground+1);
        await backgroundPage.getByRole('link',{name:'작품',exact:true}).first().click();
        nextPageSnapshotDelay=2000;
        await backgroundPage.locator('.desktop-session').first().click();
        await backgroundPage.locator('.chat-scroll').waitFor();
        await backgroundPage.locator('.chat-message').last().getByText(/Generated AI story paragraph/).first().waitFor();
        assert.equal(modelRequests,modelsBeforeBackground+1,'navigation must not restart a paid generation');
        assert.equal(await backgroundPage.locator('.chat-stream').count(),0);
        modelDelay=0;
        console.log(JSON.stringify({backgroundGenerationPreserved:true,lateInitialPageCannotOverwriteCompletion:true}));
        await background.close();
        // First send in a fluid single-work room must use a fresh catalog even
        // while the display's independent theme request is still pending.
        session.theme_override = null;
        session.work_combination_enabled = false;
        themeRows = [{id:'first-send-theme',work_id:workId,owner_id:userId,work_shared:true,name:'First send scene',ai_prompt:'FIRST_SEND_CATALOG_SENTINEL'}, {id:'second-scene',work_id:workId,owner_id:userId,work_shared:true,name:'Second scene',ai_prompt:'Other place'}];
        themeDelay = 1500;
        const promptContext = await browser.newContext({serviceWorkers:'block'});
        await setup(promptContext);
        const promptPage = await promptContext.newPage();
        await promptPage.goto(origin+'/chat/'+sessionId);
        await promptPage.waitForFunction(()=>!!document.querySelector('button[aria-label="메시지 전송"]')&&!document.querySelector('button[aria-label="메시지 전송"]').disabled);
        await promptPage.getByPlaceholder('메시지 입력…').fill('Use the first-send scene');
        await promptPage.getByRole('button',{name:'메시지 전송',exact:true}).click();
        await promptPage.waitForFunction(()=>!!document.querySelector('button[aria-label="메시지 전송"]')&&!document.querySelector('button[aria-label="메시지 전송"]').disabled);
        assert(JSON.stringify(modelPayloads.at(-1)).includes('FIRST_SEND_CATALOG_SENTINEL'),'first send must include the pending work theme catalog');
        assert(JSON.stringify(modelPayloads.at(-1)).includes('이름: First send scene'),'single-work catalogs must retain unqualified scene names');
        themeDelay = 0;
        const modelsBeforeReroll = modelRequests;
        const writes = () => requests.filter(r=>['POST','PATCH','DELETE'].includes(r.method)).length;
        const writesBeforeReroll = writes();
        generationSummaryTurn = messages.filter(message=>message.role==='user'&&!message.is_hidden).length;
        failRerollSummary = true;
        const summariesBefore = requests.filter(r=>r.path==='summary_versions').length;
        await promptPage.getByRole('button',{name:'다시 생성',exact:true}).click();
        await promptPage.getByRole('dialog',{name:'재생성 지침',exact:true}).getByRole('button',{name:'답변 재생성',exact:true}).click();
        while(requests.filter(r=>r.path==='summary_versions').length===summariesBefore)await promptPage.waitForTimeout(10);
        await promptPage.waitForFunction(()=>!!document.querySelector('button[aria-label="메시지 전송"]')&&!document.querySelector('button[aria-label="메시지 전송"]').disabled);
        assert.equal(modelRequests,modelsBeforeReroll,'failed summary reads must not regenerate with missing memory');
        assert.equal(writes(),writesBeforeReroll,'failed reroll context must not write messages');
        failRerollSummary = false; generationSummaryTurn = 0;
        const lastUser = messages.findLast(message=>message.role==='user'&&!message.is_hidden);
        lastUser.command_id='legacy-command'; lastUser.command_name='Legacy'; lastUser.command_prompt=null;
        failRerollCommand = true;
        const commandsBefore = requests.filter(r=>r.path==='commands').length;
        await promptPage.getByRole('button',{name:'다시 생성',exact:true}).click();
        await promptPage.getByRole('dialog',{name:'재생성 지침',exact:true}).getByRole('button',{name:'답변 재생성',exact:true}).click();
        while(requests.filter(r=>r.path==='commands').length===commandsBefore)await promptPage.waitForTimeout(10);
        await promptPage.waitForFunction(()=>!!document.querySelector('button[aria-label="메시지 전송"]')&&!document.querySelector('button[aria-label="메시지 전송"]').disabled);
        assert.equal(modelRequests,modelsBeforeReroll,'failed command reads must not regenerate with missing commands');
        assert.equal(writes(),writesBeforeReroll);
        failRerollCommand = false;
        console.log(JSON.stringify({firstSendFreshSingleWorkCatalog:true,rerollSummaryFailurePreservesContext:true,rerollCommandFailurePreservesContext:true}));
        await promptContext.close();
        // Complete output survives both final-save failures and a full reload.
        session.theme_override='builtin';
        const retainedContext = await browser.newContext({serviceWorkers:'block'});
        await setup(retainedContext);
        const retainedPage = await retainedContext.newPage();
        await retainedPage.goto(origin+'/chat/'+sessionId);
        await retainedPage.waitForFunction(()=>!!document.querySelector('button[aria-label="메시지 전송"]')&&!document.querySelector('button[aria-label="메시지 전송"]').disabled);
        const modelsBeforeRecovery=modelRequests, rowsBeforeRecovery=messages.length;
        failFinalCommits=2; loseBeginReply=true;
        await retainedPage.getByPlaceholder('메시지 입력…').fill('Keep the answer after both save failures');
        await retainedPage.getByRole('button',{name:'메시지 전송',exact:true}).click();
        await retainedPage.getByRole('alert',{name:'보관한 답변',exact:true}).waitFor();
        assert.equal(modelRequests,modelsBeforeRecovery+1);
        assert.equal(messages.length,rowsBeforeRecovery+2,'lost start reply cannot create duplicate turns');
        assert(messages.at(-1).content==='','failed final save must remain unconfirmed');
        await retainedPage.reload();
        await retainedPage.getByRole('alert',{name:'보관한 답변',exact:true}).waitFor();
        await retainedPage.getByRole('button',{name:'저장 다시 확인',exact:true}).click();
        await retainedPage.getByRole('alert',{name:'보관한 답변',exact:true}).waitFor({state:'hidden'});
        assert.equal(modelRequests,modelsBeforeRecovery+1,'saving a retained answer must never regenerate it');
        assert.equal(messages.at(-1).generation_status,'complete');
        assert(messages.at(-1).content.includes('Generated AI story paragraph'));
        console.log(JSON.stringify({retainedAnswerSurvivesReload:true,boundedFinalSaveRetry:true,lostStartReplyNoDuplicates:true,recoveryModelCalls:0}));
        await retainedContext.close();
        const branching = await browser.newContext({serviceWorkers:'block'});
        await setup(branching);
        const branchPage = await branching.newPage();
        await branchPage.goto(origin+'/chat/'+sessionId);
        await branchPage.waitForFunction(()=>!!document.querySelector('button[aria-label="메시지 전송"]')&&!document.querySelector('button[aria-label="메시지 전송"]').disabled);
        failBranchReply=true;
        const beforeBranchRequests=requests.length, modelsBeforeBranch=modelRequests;
        await branchPage.locator('.chat-message').last().getByRole('button',{name:'여기서 분기',exact:true}).click();
        await branchPage.getByRole('dialog').getByRole('button',{name:'분기',exact:true}).click();
        await branchPage.waitForURL(url=>url.pathname==='/chat/'+branchResult?.id);
        await branchPage.locator('.chat-scroll').waitFor();
        assert.equal(branchCalls,1,'lost branch acknowledgement must recover the saved room without another copy');
        assert.equal(modelRequests,modelsBeforeBranch);
        assert(!requests.slice(beforeBranchRequests).some(r=>['sessions','messages','summary_versions','story_notes'].includes(r.path)&&r.method==='POST'),'branch children must only be copied inside the transaction');
        branchDelay=1500;
        const callsBeforeLeaving=branchCalls;
        await branchPage.locator('.chat-message').last().getByRole('button',{name:'여기서 분기',exact:true}).click();
        await branchPage.getByRole('dialog').getByRole('button',{name:'분기',exact:true}).click();
        while(branchCalls===callsBeforeLeaving)await branchPage.waitForTimeout(10);
        await branchPage.getByRole('link',{name:'작품',exact:true}).first().click();
        await branchPage.waitForTimeout(1700);
        assert.equal(new URL(branchPage.url()).pathname,'/works','a late branch reply must not pull the user back after navigation');
        branchDelay=0;
        console.log(JSON.stringify({atomicBranchNavigation:true,lostBranchAcknowledgementRecovery:true,clientChildWrites:0}));
        await branching.close();
        // The actual editor keeps changes made after a submitted snapshot.
        const editorContext = await browser.newContext({serviceWorkers:'block'});
        await setup(editorContext);
        let releaseEditorSave, editorSaveBody;
        await editorContext.route('https://loading-check.test/rest/v1/rpc/save_work_editor',async route=>{
            editorSaveBody=route.request().postDataJSON();
            await new Promise(resolve=>releaseEditorSave=resolve);
            await route.fulfill({status:200,contentType:'application/json',body:'true'});
        });
        const editorPage = await editorContext.newPage();
        await editorPage.goto(origin+'/create/'+workId);
        const titleInput=editorPage.locator('.editor-basic input:not([type="file"])').first();
        await titleInput.waitFor();
        await titleInput.fill('Submitted title');
        await editorPage.locator('.work-editor-header button').last().click();
        const editorDeadline=Date.now()+10000;
        while(!releaseEditorSave&&Date.now()<editorDeadline)await editorPage.waitForTimeout(10);
        assert(releaseEditorSave,'editor must use the atomic save RPC');
        await titleInput.fill('Newer unsaved title');
        releaseEditorSave();
        await editorPage.waitForFunction(()=>!document.querySelector('.work-editor-header button:last-child').disabled);
        assert.equal(await titleInput.inputValue(),'Newer unsaved title');
        assert.equal(editorSaveBody.desired.work.title,'Submitted title');
        assert((await editorPage.locator('.work-editor-header button').last().textContent()).includes('저장'));
        assert((await editorPage.evaluate(id=>localStorage.getItem('inuchat:work-editor-draft:'+id),workId)).includes('Newer unsaved title'));
        console.log(JSON.stringify({editorAtomicSave:true,newerEditorInputAndDraftPreserved:true}));
        await editorContext.close();
        // A failed settings read cannot offer an empty global-prompt save.
        const adminContext = await browser.newContext({serviceWorkers:'block'});
        await setup(adminContext);
        let adminLoadFailed=true, adminSaves=0, adminSaveBody;
        const adminConfig={system_prompt:'ORIGINAL GLOBAL',theme_prompt:'ORIGINAL THEME',multichat_system_prompt:'ORIGINAL MULTI',work_combination_prompt:''};
        await adminContext.route('https://loading-check.test/rest/v1/platform_config*',route=>route.fulfill({status:adminLoadFailed?503:200,contentType:'application/json',body:JSON.stringify(adminLoadFailed?{message:'configuration unavailable'}:adminConfig)}));
        await adminContext.route('https://loading-check.test/rest/v1/rpc/save_platform_prompts',route=>{
            adminSaves++;adminSaveBody=route.request().postDataJSON();
            assert(route.request().url().length<200,'long prompts must not be put in URL filters');
            return route.fulfill({status:200,contentType:'application/json',body:'true'});
        });
        const adminPage=await adminContext.newPage();
        await adminPage.goto(origin+'/settings');
        await adminPage.getByText('전역 프롬프트를 불러오지 못했습니다. 기존 내용은 변경하지 않았습니다.',{exact:true}).waitFor();
        assert.equal(await adminPage.getByRole('heading',{name:'관리자 — 전역 시스템 프롬프트',exact:true,includeHidden:true}).count(),0);
        assert.equal(adminSaves,0);
        adminLoadFailed=false;
        await adminPage.getByRole('button',{name:'설정 다시 불러오기',exact:true}).click();
        await adminPage.getByRole('button',{name:'운영자',exact:true}).click();
        await adminPage.getByRole('heading',{name:'관리자 — 전역 시스템 프롬프트',exact:true}).waitFor();
        const globalPromptSection=adminPage.getByRole('heading',{name:'관리자 — 전역 시스템 프롬프트',exact:true}).locator('..');
        await globalPromptSection.locator('textarea').first().fill('LONG PROMPT '.repeat(1000));
        await globalPromptSection.getByRole('button',{name:'저장',exact:true}).click();
        await adminPage.getByText('전역 시스템 프롬프트를 저장했습니다.',{exact:true}).waitFor();
        assert.equal(adminSaves,1);assert.equal(adminSaveBody.previous.system_prompt,'ORIGINAL GLOBAL');
        assert.equal(adminSaveBody.desired.theme_prompt,'ORIGINAL THEME');assert.equal(adminSaveBody.desired.multichat_system_prompt,'ORIGINAL MULTI');
        console.log(JSON.stringify({failedAdminReadCannotErasePrompts:true,longPromptBodySave:true,otherPromptsPreserved:true}));
        await adminContext.close();

        // Changing a variant in the same tab increments versions on the server.
        // Verify the new version is used immediately, without reopening the room.
        const selectionContext=await browser.newContext({serviceWorkers:'block'});
        await setup(selectionContext);
        const selectionPage=await selectionContext.newPage();
        selectionPage.on('pageerror',e=>errors.push(e.message));
        const snapshot=structuredClone(messages);
        const previous=messages.findLast(m=>m.role==='assistant'&&m.is_active_variant);
        const groupId=previous.reroll_group_id??previous.id;
        const variant={...previous,id:'same-window-variant',reroll_group_id:groupId,reroll_index:(previous.reroll_index??1)+1,
            content:'Second version for same-window editing',is_active_variant:false,content_version:0};
        messages.push(variant);
        await selectionPage.goto(origin+'/chat/'+sessionId);
        await selectionPage.waitForFunction(()=>!!document.querySelector('button[aria-label="메시지 전송"]')&&!document.querySelector('button[aria-label="메시지 전송"]').disabled);
        await selectionPage.getByLabel('리롤 답변 선택').last().selectOption(variant.id);
        const selected=selectionPage.locator('[data-scroll-anchor="'+variant.id+'"]');
        await selected.getByText(variant.content,{exact:true}).waitFor();
        await selected.getByRole('button',{name:'메시지 편집',exact:true}).click();
        await selected.locator('textarea').fill('Edited immediately after selecting');
        const selectionEditStart=requests.length;
        await selected.getByRole('button',{name:'저장',exact:true}).click();
        await selected.locator('textarea').waitFor({state:'hidden'});
        assert.equal(messages.find(m=>m.id===variant.id).content,'Edited immediately after selecting');
        assert.equal(requests.slice(selectionEditStart).filter(r=>r.path==='rpc/mutate_session_message').length,1,'latest server version must be reflected without a conflict/retry');
        await selected.getByRole('button',{name:'메시지 편집',exact:true}).click();
        messages=messages.map(m=>m.id===variant.id?{...m,content:'Actual external change',content_version:m.content_version+1}:m);
        await selected.locator('textarea').fill('Keep my unsaved edit');
        await selected.getByRole('button',{name:'저장',exact:true}).click();
        await selectionPage.getByText(/저장된 메시지가 변경되었습니다/).first().waitFor();
        assert.equal(await selected.locator('textarea').inputValue(),'Keep my unsaved edit');
        assert.equal(messages.find(m=>m.id===variant.id).content,'Actual external change','a real conflict is not overwritten');
        console.log(JSON.stringify({sameWindowSelectionEdit:true,latestServerVersionUsed:true,realConflictDraftPreserved:true}));
        await selectionContext.close();messages=snapshot;

        // Hold the dialogue request open. Theme preparation must still start,
        // but the model cannot be called until the dialogue is released.
        const parallelContext=await browser.newContext({serviceWorkers:'block'});
        await setup(parallelContext);
        const parallelPage=await parallelContext.newPage();
        const previousTheme=session.theme_override;session.theme_override=null;
        await parallelPage.goto(origin+'/chat/'+sessionId);
        await parallelPage.waitForFunction(()=>!!document.querySelector('button[aria-label="메시지 전송"]')&&!document.querySelector('button[aria-label="메시지 전송"]').disabled);
        await parallelPage.waitForTimeout(200);
        const parallelStart=requests.length, modelsBeforeParallel=modelRequests;
        holdGenerationContext=true;releaseGenerationContext=undefined;
        try {
            await parallelPage.getByPlaceholder('메시지 입력…').fill('Parallel preparation fixture');
            await parallelPage.getByRole('button',{name:'메시지 전송',exact:true}).click();
            const until=Date.now()+3000;
            while((!releaseGenerationContext||!requests.slice(parallelStart).some(r=>r.path==='themes'))&&Date.now()<until)await parallelPage.waitForTimeout(10);
            assert(releaseGenerationContext,'dialogue request was held');
            assert(requests.slice(parallelStart).some(r=>r.path==='themes'),'fresh themes must load while dialogue is still pending');
            assert.equal(modelRequests,modelsBeforeParallel,'no model call before all prompt data is ready');
        } finally { holdGenerationContext=false;releaseGenerationContext?.(); }
        await parallelPage.waitForFunction(()=>!document.querySelector('.chat-stream'));
        assert.equal(modelRequests,modelsBeforeParallel+1);
        const traces=await parallelPage.evaluate(()=>JSON.parse(sessionStorage.getItem('inuchat.timings.v1')??'[]'));
        const trace=traces.findLast(t=>t.operation==='send');
        assert(trace&&trace.stages['model-request']!==undefined&&trace.stages['first-content']!==undefined&&trace.stages.save!==undefined);
        assert(!JSON.stringify(traces).includes('Parallel preparation fixture'),'timings cannot contain message text');
        console.log(JSON.stringify({parallelThemePreparation:true,noPrematureModelCall:true,firstEventAndContentTimings:true}));
        session.theme_override=previousTheme;
        await parallelContext.close();

    }
}
finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
}
