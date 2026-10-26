import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';

const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const original = {
  id: 'message', session_id: 'room', role: 'assistant', content: 'unchanged body',
  content_version: 0, command_id: null, command_name: null, command_prompt: null,
  is_hidden: false, is_active_variant: true, generation_status: 'complete',
  reroll_group_id: null, turn_index: 1,
};
const edit = { content: 'edited body', command_id: null, command_name: null };
let mode, remote, posts, reads, writes;
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const client = createClient('https://version-sync.test', 'fixture', {
  auth: { persistSession: false, autoRefreshToken: false }, db: { retry: false },
  global: { fetch: async (input, init) => {
    const url = new URL(input);
    if (init.method === 'GET') { reads++; return json([remote]); }
    assert(url.pathname.endsWith('mutate_session_message'));
    posts++;
    const args = JSON.parse(init.body);
    if (mode === 'generating') return new Response(JSON.stringify({ code: '40001', message: 'Response is generating in another screen' }), { status: 409 });
    if (mode === 'network-same-window' && posts === 1) throw new TypeError('Load failed');
    if (mode === 'changed-again' && posts === 2) remote = { ...remote, content: 'second external edit', content_version: 3 };
    if (remote.content === args.message_text) return json({ message: remote, session: { id: 'room' }, replacement: null, deleted: false });
    if (remote.content_version !== args.expected_version) return new Response(JSON.stringify({ code: '40001', message: 'Message changed; preserve your draft and refresh' }), { status: 409 });
    writes++;
    remote = { ...remote, content: args.message_text, content_version: remote.content_version + 1 };
    if (mode === 'lost-reply' && posts === 1) throw new TypeError('Load failed');
    return json({ message: remote, session: { id: 'room' }, replacement: null, deleted: false });
  } },
});
globalThis.__versionSyncClient = client;
const source = readFileSync(new URL('../src/lib/messageMutations.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const stub = uri('export const supabase = globalThis.__versionSyncClient;');
const { mutateMessage } = await import(uri(compiled.replace("'./supabase'", JSON.stringify(stub))));
const reset = next => { mode = next; posts = reads = writes = 0; remote = { ...original, content_version: 2 }; };
try {
  for (const scenario of ['same-window', 'network-same-window']) {
    reset(scenario);
    const result = await mutateMessage({ ...original }, edit);
    assert.equal(result.message.content, edit.content);
    assert.equal(writes, 1, 'a stale local version cannot duplicate the edit');
    assert.equal(posts, 2, 'rebase is bounded to one guarded retry');
    assert.equal(reads, 1);
  }
  for (const changed of [
    { content: 'external edit' }, { command_id: 'other-command' }, { command_name: 'other' },
    { command_prompt: 'changed prompt' }, { is_active_variant: false }, { is_hidden: true },
  ]) {
    reset('conflict'); remote = { ...remote, ...changed };
    await assert.rejects(mutateMessage({ ...original }, edit), /변경/);
    assert.equal(writes, 0, 'a real change must retain the draft without an overwrite');
    assert.equal(posts, 1);
  }
  reset('changed-again');
  await assert.rejects(mutateMessage({ ...original }, edit), /변경/);
  assert.equal(writes, 0); assert.equal(posts, 2);
  reset('generating');
  await assert.rejects(mutateMessage({ ...original }, edit), /생성/);
  assert.equal(posts, 1); assert.equal(reads, 0); assert.equal(writes, 0);
  reset('lost-reply'); remote = { ...original };
  assert.equal((await mutateMessage({ ...original }, edit)).message.content, edit.content);
  assert.equal(writes, 1); assert.equal(posts, 2);
  reset('missing-version'); remote = { ...original };
  const unversioned = { ...original }; delete unversioned.content_version;
  assert.equal((await mutateMessage(unversioned, edit)).message.content, edit.content);
  assert.equal(writes, 1);
  console.log('Edit version sync: same-window stale version/network recovery, actual conflicts, generation guard, lost reply and missing-version refresh passed');
} finally { delete globalThis.__versionSyncClient; }
