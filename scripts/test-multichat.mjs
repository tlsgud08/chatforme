import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'vite';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const migrationName = readdirSync(new URL('../supabase/migrations/', import.meta.url))
  .find(name => name.endsWith('_multichat_pc_alternating_keys.sql'));
const migration = read('supabase/migrations/' + migrationName);
const db = new PGlite();
const ids = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003'];
const room = '10000000-0000-0000-0000-000000000001';
const personas = ['20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002'];
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
async function login(index) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [index === null ? '' : ids[index]]);
  await db.exec(index === null ? 'set role anon' : 'set role authenticated');
}
const claim = reroll => query('select claim_multichat_generation($1,$2) round', [room, !!reroll]);
const finish = (round, failed = false) => query('select complete_multichat_generation($1,$2,$3,10,20,0.01,$4)', [room, round, failed ? '' : `answer ${round}`, failed]);
try {
  await db.exec(`create role authenticated; create role anon; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table profiles(id uuid primary key);
    create table works(id uuid primary key);
    create table platform_config(id integer primary key);
    create table personas(id uuid primary key,user_id uuid references profiles(id),name text,description text);
    alter table personas enable row level security;
    create policy personas_all_own on personas for all using(auth.uid()=user_id) with check(auth.uid()=user_id);`);
  const initial = read('supabase/migrations/0029_multichat.sql')
    .replace(/create extension if not exists pgcrypto;/gi, '')
    .replace(/do \$\$ begin alter publication[\s\S]*?end \$\$;/gi, '');
  await db.exec(initial);
  await db.exec(`grant usage on schema public,auth to authenticated,anon;
    grant select,insert,update,delete on all tables in schema public to authenticated,anon;
    insert into profiles values('${ids[0]}'),('${ids[1]}'),('${ids[2]}');
    insert into works values('${room}');
    insert into personas values('${personas[0]}','${ids[0]}','Host persona','HOST DESCRIPTION'),('${personas[1]}','${ids[1]}','Guest persona','GUEST DESCRIPTION');
    insert into multichat_rooms(id,work_id,host_user_id,title,status,current_round,model)
      values('${room}','${room}','${ids[0]}','Fixture','active',1,'fixture/plain');
    insert into multichat_members(room_id,user_id,slot,persona_id) values
      ('${room}','${ids[0]}',1,'${personas[0]}'),('${room}','${ids[1]}',2,'${personas[1]}');`);
  await db.exec(migration);
  await db.exec(migration); // Safe to reapply the policy/function definitions.
  for (const index of [0, 1, 2]) {
    await login(index);
    assert.equal((await query('select * from personas')).length, 2, 'all signed-in users can read both personas');
    assert.equal((await query("update personas set description='forged' where user_id<>auth.uid() returning id")).length, 0);
    assert.equal((await query('delete from personas where user_id<>auth.uid() returning id')).length, 0);
    await assert.rejects(() => query('insert into personas values(gen_random_uuid(),$1,\'forged\',\'forged\')', [ids[(index + 1) % 3]]));
  }
  await login(0);
  assert.equal((await query("update personas set description='HOST DESCRIPTION' where user_id=auth.uid() returning id")).length, 1, 'the owner can still edit');
  await login(null);
  assert.equal((await query('select * from personas')).length, 0, 'signed-out access remains closed');
  await assert.rejects(() => claim(false));
  await assert.rejects(() => finish(1));
  await login(2);
  await assert.rejects(() => claim(false));
  await assert.rejects(() => finish(1));

  for (let round = 1; round <= 4; round++) {
    const payer = (round - 1) % 2;
    await login(0);
    await query('select submit_multichat_turn($1,$2)', [room, `host ${round}`]);
    await login(1);
    assert.equal((await query('select * from multichat_submissions where round_number=$1', [round])).length, 0);
    await query('select submit_multichat_turn($1,$2)', [room, round === 2 ? '' : `guest ${round}`]);
    await assert.rejects(() => query('select submit_multichat_turn($1,$2)', [room, 'duplicate']));
    await login(1 - payer);
    await assert.rejects(() => claim(false), /API 키/);
    await login(payer);
    assert.equal((await query(`select p.description from multichat_members m join personas p on p.id=m.persona_id where m.room_id=$1 order by m.slot`, [room])).length, 2);
    assert.equal((await claim(false))[0].round, round);
    assert.equal((await claim(false))[0].round, 0, 'a second tab cannot claim a streaming round');
    assert.equal((await query("select content from multichat_messages where round_number=$1 and role='user'", [round]))[0].content,
      `PC1: host ${round}\n\nPC2: ${round === 2 ? '[skip]' : `guest ${round}`}`);
    await login(1 - payer);
    await assert.rejects(() => finish(round), /완료/);
    await login(payer);
    if (round === 2) {
      await finish(round, true);
      assert.equal((await query('select current_round from multichat_rooms'))[0].current_round, 2);
      assert.equal((await claim(false))[0].round, 2, 'retry retains PC2 assignment');
    }
    await finish(round);
    await finish(round); await finish(round, true);
    const state = (await query('select current_round,total_input_tokens,total_output_tokens,total_cost from multichat_rooms'))[0];
    assert.deepEqual(state, { current_round: round + 1, total_input_tokens: round * 10, total_output_tokens: round * 20, total_cost: (round * 0.01).toString() });
  }
  // Round 4 rerolls belong to PC2, even while round 5 belongs to PC1.
  await login(0); await assert.rejects(() => claim(true), /API 키/);
  await login(1); assert.equal((await claim(true))[0].round, 4);
  await finish(4, true);
  assert.equal((await query("select count(*)::int n from multichat_messages where round_number=4 and role='assistant' and is_active_variant and generation_status='complete'"))[0].n, 1, 'failed reroll preserves the old answer');
  await login(0); await assert.rejects(() => claim(false), /리롤/);
  await login(1); assert.equal((await claim(true))[0].round, 4);
  await finish(4); await finish(4);
  assert.equal((await query('select current_round from multichat_rooms'))[0].current_round, 5);
  assert.equal((await query('select total_cost from multichat_rooms'))[0].total_cost, '0.05', 'reroll costs are counted exactly once');
  assert.equal((await query("select count(*)::int n from multichat_messages where round_number=4 and role='assistant' and is_active_variant"))[0].n, 1);
  console.log('Multichat DB: alternating claims/completions, persona reads and owned writes, hidden submissions, skips, retries, rerolls and idempotent usage passed');
} finally { await db.close(); }

// Exercise the actual page generation callback and OpenRouter adapter together.
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const savedFetch = globalThis.fetch;
const savedStorage = globalThis.localStorage;
try {
  const helper = await server.ssrLoadModule('/src/lib/multichat.ts');
  const { generate } = await server.ssrLoadModule('/src/lib/llm/index.ts');
  const { getApiKey } = await server.ssrLoadModule('/src/lib/apiKeys.ts');
  const source = ts.createSourceFile('MultichatPage.tsx', read('src/pages/MultichatPage.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'runGeneration') callback = node.initializer.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(callback);
  const code = ts.transpileModule('const runGeneration=' + callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nrunGeneration';
  const people = [1, 2].map(slot => ({ slot, profiles: { display_name: `profile ${slot}` }, personas: { name: `persona ${slot}`, description: `description ${slot}` } }));
  let sent = [], completions = [], errors = [], saveFails = false, pending = null, failModel = false;
  globalThis.window = { location: { origin: 'https://inuchat.test' } };
  globalThis.fetch = async (_url, init) => {
    sent.push({ key: init.headers.authorization, body: JSON.parse(init.body) });
    if (failModel) throw new Error('model failed');
    return new Response('data: {"choices":[{"delta":{"content":"reply"}}]}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":20,"cost":0.01}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  function env(round, slot, key, existing = []) {
    globalThis.localStorage = { getItem: k => k === 'chatforme.apiKeys' ? JSON.stringify({ openrouter: key }) : null, setItem: () => {} };
    const history = [...existing, { role: 'user', content: 'user1: action\n\nuser2: [skip]', round_number: round }];
    const context = {
      room: { id: room, current_round: round, model: 'fixture/plain', output_tokens: null },
      work: { main_prompt: 'main user1', multichat_prompt: 'work user2' }, mySlot: slot,
      generating: { current: false }, pendingCompletion: null,
      setGenerationRound: () => {}, setMessages: () => {}, load: async () => {},
      setPendingCompletion: value => { pending = value; }, showToast: message => errors.push(message),
      getApiKey, generate, ...helper, loadDefaultReasoning: () => ({ send: false }),
      supabase: {
        rpc: async (name, args) => {
          if (name === 'claim_multichat_generation') return { data: args.is_reroll ? round - 1 : round, error: null };
          completions.push(args); return { error: saveFails ? { message: 'save failed' } : null };
        },
        from: name => {
          const result = { data: name === 'platform_config' ? { system_prompt: 'platform', multichat_system_prompt: 'rules user1 user2' } : name === 'multichat_members' ? people : history, error: null };
          const builder = { select: () => builder, eq: () => builder, lte: (_field, limit) => { result.data = history.filter(message => message.round_number <= limit); return builder; }, order: () => builder, single: async () => result, then: (yes, no) => Promise.resolve(result).then(yes, no) };
          return builder;
        },
      },
    };
    return vm.runInNewContext(code, context);
  }
  for (const [round, payer] of [[1, 1], [2, 2], [3, 1], [4, 2]]) {
    const before = sent.length;
    await env(round, payer === 1 ? 2 : 1, 'WRONG KEY')();
    assert.equal(sent.length, before, 'non-payer does not issue an HTTP request');
    await env(round, payer, `KEY PC${payer}`)();
    assert.equal(sent.at(-1).key, `Bearer KEY PC${payer}`);
    const { body } = sent.at(-1);
    assert.equal(body.stream, true);
    assert.match(body.messages[0].content, /PC1: persona 1\ndescription 1\n\nPC2: persona 2\ndescription 2/);
    assert.equal(body.messages[1].content, 'PC1: action\n\nPC2: [skip]');
    assert.doesNotMatch(JSON.stringify(body), /user[12]/i);
    assert.equal(completions.at(-1).target_round, round);
    assert.equal(completions.at(-1).failed, false);
  }
  const before = sent.length;
  await env(2, 2, '')(); assert.equal(sent.length, before, 'missing own key never falls back to the other user');
  assert.match(errors.at(-1), /PC2/);
  await env(5, 2, 'REROLL PC2', [
    { role: 'user', content: 'PC1: round 4 action\n\nPC2: round 4 action', round_number: 4 },
    { role: 'assistant', content: 'OLD ANSWER MUST NOT BE SENT', round_number: 4, generation_status: 'complete', is_active_variant: true },
  ])(true);
  assert.equal(sent.at(-1).key, 'Bearer REROLL PC2');
  assert.equal(completions.at(-1).target_round, 4);
  assert.doesNotMatch(JSON.stringify(sent.at(-1).body), /OLD ANSWER MUST NOT BE SENT/);
  assert.equal(sent.at(-1).body.messages.at(-1).content, 'PC1: round 4 action\n\nPC2: round 4 action');
  failModel = true; await env(2, 2, 'PC2')(); failModel = false;
  assert.equal(completions.at(-1).failed, true);
  saveFails = true; await env(2, 2, 'PC2')(); saveFails = false;
  assert.equal(pending.response_content, 'reply', 'save failure retains the paid response for a save-only retry');
  assert.equal(pending.failed, false);
  let retrySource;
  function findRetry(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'retryCompletion') retrySource = node.getText(source);
    ts.forEachChild(node, findRetry);
  }
  findRetry(source);
  const requestCount = sent.length;
  let savedResponse;
  const retry = vm.runInNewContext(ts.transpileModule(retrySource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nretryCompletion', {
    pendingCompletion: pending, roomId: room, generating: { current: false },
    setGenerationRound: () => {}, setPendingCompletion: () => {}, load: async () => {}, showToast: () => {},
    supabase: { rpc: async (_name, args) => { savedResponse = args; return { error: null }; } },
  });
  await retry();
  assert.equal(savedResponse.response_content, 'reply');
  assert.equal(sent.length, requestCount, 'save-only retry makes no new model request');
  console.log('Multichat client: actual page callback and HTTP adapter use each payer’s local key, PC prompt/history, both personas, missing-key/failure handling passed');
} finally {
  globalThis.fetch = savedFetch; globalThis.localStorage = savedStorage;
  await server.close();
}
