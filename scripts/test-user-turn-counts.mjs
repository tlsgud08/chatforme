import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { QueryClient } from '@tanstack/react-query';
import { createServer } from 'vite';

const dir = new URL('../supabase/migrations/', import.meta.url);
const sql = readFileSync(new URL(readdirSync(dir).find(name => name.endsWith('_user_turn_counts_consistency.sql')), dir), 'utf8');
const db = new PGlite();
const owner = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002';
const one = '10000000-0000-0000-0000-000000000001', empty = '10000000-0000-0000-0000-000000000002', foreign = '10000000-0000-0000-0000-000000000003';
try {
  await db.exec(`create role authenticated; create role anon; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table sessions(id uuid primary key,user_id uuid);
    create table messages(id uuid primary key default gen_random_uuid(),session_id uuid,role text,is_hidden boolean default false,is_active_variant boolean default true,turn_index integer);
    alter table sessions enable row level security; alter table messages enable row level security;
    create policy own_sessions on sessions to authenticated using(user_id=(select auth.uid()));
    create policy own_messages on messages to authenticated using(exists(select 1 from sessions s where s.id=messages.session_id));
    grant usage on schema public,auth to authenticated,anon; grant select,insert,update,delete on sessions,messages to authenticated;
  `);
  await db.exec(readFileSync(new URL('20261014061314_session_conversation_counts.sql', dir), 'utf8'));
  await db.exec(sql);
  await db.query('insert into sessions values($1,$4),($2,$4),($3,$5)', [one, empty, foreign, owner, other]);
  await db.query("insert into messages(session_id,role,turn_index) select $1,'user',n from generate_series(1,1205)n", [one]);
  await db.query("insert into messages(session_id,role,turn_index) select $1,'assistant',n from generate_series(1,1204)n", [one]);
  await db.query(`insert into messages(session_id,role,turn_index,is_hidden,is_active_variant) values
    ($1,'user',0,false,true),($1,'user',1206,true,true),($1,'user',1207,false,false),
    ($1,'assistant',1204,false,true),($1,'assistant',1204,false,false),($2,'user',1,false,true)`, [one, foreign]);
  const rowsBefore = (await db.query('select * from messages order by id')).rows;
  await db.exec(sql);
  assert.deepEqual((await db.query('select * from messages order by id')).rows, rowsBefore, 'reapplying changes no conversation data');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
  await db.exec('set role authenticated');
  const count = async () => Number((await db.query('select * from session_conversation_counts($1)', [[one]])).rows[0].conversation_count);
  const result = (await db.query('select * from session_conversation_counts($1)', [[one, one, empty, foreign]])).rows;
  assert.equal(result.length, 2, 'foreign and duplicate IDs cannot leak or duplicate results');
  assert.equal(result.find(row => row.session_id === empty).conversation_count, 0);
  assert.equal(await count(), 1206, 'unanswered user and visible legacy turn zero are included; hidden/inactive users are excluded');
  await db.query("delete from messages where id=(select id from messages where session_id=$1 and role='assistant' limit 1)", [one]);
  assert.equal(await count(), 1206, 'deleting an assistant does not delete a user turn');
  await db.query("delete from messages where session_id=$1 and role='user' and turn_index=1000", [one]);
  assert.equal(await count(), 1205, 'deleting a user decrements the count without renumbering');
  await db.query("insert into messages(session_id,role,turn_index) values($1,'assistant',1300)", [one]);
  assert.equal(await count(), 1205, 'continuation/reroll does not invent a user turn');
  assert.equal((await db.query('select * from session_conversation_counts(null)')).rows.length, 0);
  assert.equal((await db.query('select * from session_conversation_counts(array[]::uuid[])')).rows.length, 0);
  await db.exec('reset role; set role anon');
  await assert.rejects(db.query('select * from session_conversation_counts($1)', [[one]]), /permission denied/);
} finally { await db.close(); }

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { sessionCountsKey, cacheSessionCount, fetchSessionConversationCounts } = await server.ssrLoadModule('/src/lib/sessionCounts.ts');
  assert.deepEqual(sessionCountsKey(owner, [one, empty]), sessionCountsKey(owner, [empty, one, one]), 'reordered lists share a count cache');
  const client = new QueryClient();
  const key = sessionCountsKey(owner, [one, empty]), otherKey = sessionCountsKey(other, [one]);
  client.setQueryData(key, { [one]: 8, [empty]: 0 }); client.setQueryData(otherKey, { [one]: 4 });
  cacheSessionCount(client, owner, one, 9);
  assert.equal(client.getQueryData(key)[one], 9); assert.equal(client.getQueryData(otherKey)[one], 4);
  const { supabase } = await server.ssrLoadModule('/src/lib/supabase.ts');
  const from = supabase.from, rpc = supabase.rpc;
  const filters = [];
  supabase.rpc = () => Promise.resolve({ data: null, error: { code: 'PGRST202' } });
  supabase.from = () => {
    const chain = { select: () => chain, eq: (k,v) => { filters.push([k,v]); return chain; }, then: (resolve,reject) => Promise.resolve({ count: 9, error: null }).then(resolve,reject) };
    return chain;
  };
  try {
    assert.equal((await fetchSessionConversationCounts([one]))[one], 9);
    assert(filters.some(([k,v]) => k === 'role' && v === 'user'), 'old-schema fallback must count users too');
    assert(!filters.some(([k]) => k === 'turn_index'), 'legacy turn zero cannot be excluded');
  } finally { supabase.from = from; supabase.rpc = rpc; client.clear(); }
  console.log('User turn counts: >1000 rows, failures/continuations/variants/hidden/legacy/delete, RLS, no data rewrites, stable account cache and matching fallback passed');
} finally { await server.close(); }
