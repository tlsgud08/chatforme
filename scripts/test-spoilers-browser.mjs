import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const root = new URL('../', import.meta.url).pathname;
const fixture = await mkdtemp(root + '.spoiler-check-');
let server, browser;
try {
  await writeFile(fixture + '/index.html', '<div id="root"></div><script type="module" src="./main.tsx"></script>');
  await writeFile(fixture + '/main.tsx', `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import MessageContent from '../src/components/MessageContent';
    import Spoiler from '../src/components/Spoiler';
    import '../src/index.css';
    function App() {
      const [mode, setMode] = useState(true);
      const [stream, setStream] = useState('일반 ||생성 중');
      const body = <><p>/명령어</p><MessageContent content={'첫 문단\\n\\n**비밀** [링크](https://example.com)'} role="user" status="complete" showImages={false} /></>;
      return <><button id="toggle" onClick={() => setMode(!mode)}>모드</button>
        <div id="user" style={{background:'#6366f1',color:'white',padding:16}}>{mode ? <Spoiler key="on" block>{body}</Spoiler> : body}</div>
        <div id="regular"><MessageContent content={'일반 ||**굵게** [링크](https://example.com)|| 끝 ||둘째||'} role="assistant" status="complete" showImages={false} /></div>
        <div id="stream"><MessageContent content={stream} role="assistant" status="streaming" showImages={false} /></div>
        <button id="finish" onClick={() => setStream('일반 ||생성 완료||')}>완료</button>
      </>;
    }
    createRoot(document.getElementById('root')!).render(<App/>);
  `);
  server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${fixture.split('/').pop()}/index.html`);
  const cover = page.locator('#user > .chat-spoiler');
  await cover.waitFor();
  assert.equal(await cover.getAttribute('data-revealed'), 'false');
  assert.equal(await page.locator('#user strong').evaluate(el => getComputedStyle(el).visibility), 'hidden');
  assert.ok(!(await page.locator('#user').ariaSnapshot()).includes('비밀'));
  assert.ok(await page.locator('#user a').evaluate(el => !!el.closest('[inert]')));
  const before = await page.locator('#user').boundingBox();
  await cover.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#user strong').evaluate(el => getComputedStyle(el).visibility), 'visible');
  assert.deepEqual(await page.locator('#user').boundingBox(), before, 'reveal preserves bubble geometry');
  await page.locator('#toggle').click(); await page.locator('#toggle').click();
  assert.equal(await cover.getAttribute('data-revealed'), 'false', 'mode toggle conceals again');
  const spoilers = page.locator('#regular .chat-spoiler');
  assert.equal(await spoilers.count(), 2);
  await spoilers.first().click();
  assert.equal(await spoilers.first().getAttribute('data-revealed'), 'true');
  assert.equal(await spoilers.last().getAttribute('data-revealed'), 'false');
  assert.equal(await page.locator('#regular strong').evaluate(el => getComputedStyle(el).visibility), 'visible');
  assert.equal(await page.locator('#stream .chat-spoiler').getAttribute('data-revealed'), 'false');
  await page.locator('#finish').click();
  assert.equal(await page.locator('#stream .chat-spoiler').getAttribute('data-revealed'), 'false');
  await page.setViewportSize({ width: 390, height: 844 });
  await cover.tap({ force: true }).catch(() => cover.click());
  assert.equal(await cover.getAttribute('data-revealed'), 'true');
  assert.deepEqual(errors, []);
  console.log('Spoiler browser: masking, keyboard/click/mobile, independent reveal, links, accessibility, toggle reset, layout and streaming OK');
} finally {
  await browser?.close(); await server?.close(); await rm(fixture, { recursive: true, force: true });
}
