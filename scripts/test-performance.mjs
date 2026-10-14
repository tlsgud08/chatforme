import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'vite';
import { PGlite } from '@electric-sql/pglite';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const models = await server.ssrLoadModule('/src/lib/llm/modelDiscovery.ts');
  const key = 'inuchat.openrouter.modelCatalog';
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: `vendor/model-${i}`, name: `Model ${i}`, supportedParameters: ['reasoning'] }));
  localStorage.setItem(key, JSON.stringify(rows));
  const originalParse = JSON.parse;
  let parses = 0;
  JSON.parse = (...args) => { parses++; return originalParse(...args); };
  try {
    for (let i = 0; i < 500; i++) assert.equal(models.getOpenRouterModel(rows[i].id).name, rows[i].name);
    assert.equal(parses, 1, 'a whole catalog must not be parsed per model');
    localStorage.setItem(key, JSON.stringify([{ ...rows[0], name: 'Updated' }]));
    assert.equal(models.getOpenRouterModel(rows[0].id).name, 'Updated');
    assert.equal(models.getOpenRouterModel(rows[1].id), undefined);
    assert.equal(parses, 2, 'saved catalog changes invalidate metadata');
  } finally { JSON.parse = originalParse; }
  localStorage.setItem(key, '{broken');
  assert.deepEqual(models.loadOpenRouterModels(), []);
  localStorage.removeItem(key);
  localStorage.setItem('inuchat.openrouter.verifiedModels', '["legacy/model"]');
  assert.equal(models.isModelVerified('legacy/model'), true);

  const { shareInFlight, invalidateInFlight } = await server.ssrLoadModule('/src/lib/inFlight.ts');
  let resolveOld, reads = 0;
  const read = () => { reads++; return new Promise(resolve => { resolveOld = resolve; }); };
  const first = shareInFlight('theme:one', read), second = shareInFlight('theme:one', read);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(reads, 1);
  invalidateInFlight('theme:');
  const fresh = shareInFlight('theme:one', () => { reads++; return 'new'; });
  resolveOld('old');
  assert.equal(await first, 'old');
  assert.equal(await fresh, 'new');
  assert.equal(await shareInFlight('theme:one', () => { reads++; return 'newer'; }), 'newer');
  assert.equal(reads, 3, 'settled values are not cached');
  await assert.rejects(shareInFlight('theme:error', () => Promise.reject(new Error('failed'))));
  assert.equal(await shareInFlight('theme:error', () => 'retry'), 'retry');
} finally { await server.close(); }

const db = new PGlite();
try {
  await db.exec(`
    create role authenticated; create role anon;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table public.sessions(id uuid primary key,user_id uuid not null);
    create table public.messages(id uuid primary key,session_id uuid references sessions(id),role text,is_hidden boolean,is_active_variant boolean,turn_index integer);
    alter table sessions enable row level security; alter table messages enable row level security;
    create policy own_sessions on sessions to authenticated using(user_id=auth.uid());
    create policy own_messages on messages to authenticated using(exists(select 1 from sessions s where s.id=messages.session_id));
    grant usage on schema public,auth to authenticated,anon;
    grant select on sessions,messages to authenticated;
  `);
  const migration = readdirSync('supabase/migrations').find(name => name.endsWith('_session_conversation_counts.sql'));
  await db.exec(readFileSync('supabase/migrations/' + migration, 'utf8'));
  const user = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002';
  const one = '10000000-0000-0000-0000-000000000001', empty = '10000000-0000-0000-0000-000000000002', foreign = '10000000-0000-0000-0000-000000000003';
  await db.query('insert into sessions values($1,$4),($2,$4),($3,$5)', [one, empty, foreign, user, other]);
  await db.query(`insert into messages select gen_random_uuid(),$1,'assistant',false,true,n from generate_series(1,1205) n`, [one]);
  await db.query(`insert into messages values
    (gen_random_uuid(),$1,'assistant',false,true,0),
    (gen_random_uuid(),$1,'assistant',true,true,1),
    (gen_random_uuid(),$1,'assistant',false,false,1),
    (gen_random_uuid(),$1,'user',false,true,1),
    (gen_random_uuid(),$2,'assistant',false,true,1)`, [one, foreign]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec('set role authenticated');
  const result = await db.query('select * from session_conversation_counts($1)', [[one, empty, foreign]]);
  assert.equal(result.rows.length, 2, 'foreign session IDs must not leak');
  const counts = Object.fromEntries(result.rows.map(row => [row.session_id, Number(row.conversation_count)]));
  assert.equal(counts[one], 1205, 'row limits must not truncate counts');
  assert.equal(counts[empty], 0);
  assert.equal((await db.query('select * from session_conversation_counts(array[]::uuid[])')).rows.length, 0);
  assert.equal((await db.query('select * from session_conversation_counts(null)')).rows.length, 0);
  const old = await db.query("select count(*) from messages where session_id=$1 and role='assistant' and is_hidden=false and is_active_variant=true and turn_index>0", [one]);
  assert.equal(Number(old.rows[0].count), counts[one]);
  await db.exec('reset role');
  await db.query("delete from messages where session_id=$1 and turn_index=1205", [one]);
  await db.exec('set role authenticated');
  assert.equal(Number((await db.query('select * from session_conversation_counts($1)', [[one]])).rows[0].conversation_count), 1204);
  await db.exec('reset role; set role anon');
  await assert.rejects(db.query('select * from session_conversation_counts($1)', [[one]]), /permission denied/);
} finally { await db.close(); }
console.log('Performance tests passed: catalog invalidation, concurrent fresh reads, exact counts over 1,000 rows, RLS and anonymous denial.');
