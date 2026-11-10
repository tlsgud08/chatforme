import { createServer } from 'node:http';
import { once } from 'node:events';
import { createGateway } from '../tools/lm-studio-gateway/gateway.mjs';
const httpFetch = globalThis.fetch;

export const OWNER = '10000000-0000-0000-0000-000000000001';
export const OTHER = '10000000-0000-0000-0000-000000000002';
export const SECRET = 'fixture-only-'.repeat(4);
export const frame = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
export const tick = () => new Promise(resolve => setImmediate(resolve));
export async function fixture(options = {}) {
  let contextLength = 131072, clock = Date.now(), listed = true, received = [], aborted = 0;
  const model = { identifier: 'fixture/local', displayName: 'Local fixture', maxContextLength: 999999,
    getContextLength: async () => contextLength,
    applyPromptTemplate: async messages => messages.map(m => `<${m.role}> ${m.content}`).join('\n') + '\n<assistant>',
    countTokens: async text => text.trim().split(/\s+/u).length,
  };
  const lm = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: model.identifier }, { id: 'unloaded/model' }] })); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    req.on('close', () => { if (!res.writableEnded) aborted++; });
    res.on('close', () => { if (!res.writableEnded) aborted++; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (options.respond) { options.respond(res, received.at(-1)); return; }
    const output = frame({ choices: [{ delta: { reasoning_content: 'PRIVATE' } }] })
      + frame({ choices: [{ delta: { content: '안녕🙂' } }] })
      + frame({ usage: { prompt_tokens: 100, completion_tokens: 3, cost: 99, prompt_tokens_details: { cached_tokens: 80 } }, choices: [{ delta: {}, finish_reason: 'stop' }] })
      + frame('[DONE]');
    const bytes = Buffer.from(output);
    for (let i = 0; i < bytes.length; i += 3) res.write(bytes.subarray(i, i + 3));
    res.end();
  });
  lm.listen(0, '127.0.0.1'); await once(lm, 'listening');
  const lmUrl = `http://127.0.0.1:${lm.address().port}`;
  const gateway = createGateway({ secret: SECRET, lmUrl, fetchImpl: httpFetch, inspector: { listLoaded: async () => listed ? [model] : [] },
    now: () => clock, ...options.gateway });
  gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
  const url = `http://127.0.0.1:${gateway.server.address().port}/rpc`;
  const rpc = async (body, owner = OWNER, secret = SECRET) => {
    const res = await httpFetch(url, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'x-chatforme-user-id': owner }, body: JSON.stringify(body) });
    return { status: res.status, ...await res.json() };
  };
  const start = (request = {}, requestId = crypto.randomUUID()) => rpc({ action: 'start', requestId,
    request: { model: model.identifier, messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 256, ...request } });
  const poll = async id => {
    for (let i = 0; i < 500; i++) { const value = await rpc({ action: 'poll', id, cursor: 0 }); if (value.state !== 'running') return value; await tick(); }
    throw new Error('Fixture did not complete');
  };
  return { gateway, url, rpc, start, poll, model, received, get aborted() { return aborted; },
    setContext: n => { contextLength = n; }, unload: () => { listed = false; }, advance: ms => { clock += ms; gateway.sweep(); },
    close: async () => { gateway.close(); gateway.server.closeAllConnections(); lm.closeAllConnections(); await new Promise(resolve => lm.close(resolve)); } };
}
