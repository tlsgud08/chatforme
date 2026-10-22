import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const a = '00000000-0000-0000-0000-000000000001';
const b = '00000000-0000-0000-0000-000000000002';
const main = '10000000-0000-0000-0000-000000000001';
const extra = '10000000-0000-0000-0000-000000000002';
const other = '10000000-0000-0000-0000-000000000003';
const privateWork = '10000000-0000-0000-0000-000000000004';
const session = '20000000-0000-0000-0000-000000000001';
try {
  await db.exec(`
    create role authenticated; create role anon;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.email() returns text language sql stable as $$select current_setting('request.jwt.claim.email',true)$$;
    create table works(id uuid primary key,creator_id uuid,visibility text);
    create table sessions(id uuid primary key,user_id uuid,work_id uuid,title text default 'original');
    create table platform_config(id integer primary key,system_prompt text,theme_prompt text);
    alter table works enable row level security;
    alter table sessions enable row level security;
    alter table platform_config enable row level security;
    create policy works_select on works for select using(visibility in ('public','unlisted') or auth.uid()=creator_id);
    create policy sessions_all_own on sessions for all using(auth.uid()=user_id) with check(auth.uid()=user_id);
    create policy config_select on platform_config for select using(true);
    create policy config_update_admin on platform_config for update using(auth.email()='admin@example.test');
    grant usage on schema public,auth to authenticated,anon;
    grant select,insert,update,delete on all tables in schema public to authenticated,anon;
    insert into works values('${main}','${a}','public'),('${extra}','${b}','public'),('${other}','${b}','unlisted'),('${privateWork}','${b}','private');
    insert into sessions values('${session}','${a}','${main}','original');
    insert into platform_config values(1,'untouched system','untouched theme');
  `);
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const migration = readFileSync(new URL(readdirSync(dir).find(name => name.endsWith('_session_work_combination.sql')), dir), 'utf8');
  await db.exec(migration);
  assert.deepEqual((await db.query('select work_combination_enabled,combined_work_ids,title from sessions')).rows[0], { work_combination_enabled: false, combined_work_ids: [], title: 'original' });
  assert.equal((await db.query("select prosecdef from pg_proc where proname='validate_session_work_combination'")).rows[0].prosecdef, false);
  const initialRules = (await db.query('select work_combination_prompt from platform_config')).rows[0].work_combination_prompt;
  assert.ok(initialRules.includes('메인 작품을 최우선'));
  async function login(id, email = 'user@example.test') {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.email',$2,false)", [id, email]);
    await db.exec('set role authenticated');
  }
  async function save(enabled, ids) {
    return db.query('update sessions set work_combination_enabled=$1,combined_work_ids=$2::uuid[] where id=$3 returning *', [enabled, ids, session]);
  }
  await login(a);
  await save(true, [extra, other]);
  assert.deepEqual((await save(true, [other, extra])).rows[0].combined_work_ids, [other, extra]);
  for (const invalid of [[main], [extra, extra], [null], [privateWork]]) await assert.rejects(() => save(true, invalid));
  await assert.rejects(() => db.query("update sessions set combined_work_ids='{{" + extra + '},{' + other + "}}'::uuid[] where id=$1", [session]));
  await save(true, []); // No extra work means the original payload.
  await save(false, [extra, other]); // Keep the selected order while disabled.
  assert.equal((await db.query("update platform_config set work_combination_prompt='hacked' where id=1 returning id")).rows.length, 0);
  await login(b);
  assert.equal((await save(true, [extra])).rows.length, 0, 'another user cannot change the session');
  assert.equal((await db.query('select * from sessions')).rows.length, 0);
  await login(a);
  await save(true, [extra, other]);
  await db.exec(`reset role; update works set visibility='private' where id='${extra}';`);
  await login(a);
  await db.query("update sessions set title='still editable' where id=$1", [session]);
  await assert.rejects(() => save(true, [extra, other]), /missing or inaccessible/);
  await save(false, [extra, other]); // Access revocation must not trap the toggle on.
  await save(true, [other]);
  await db.exec(`reset role; delete from works where id='${other}';`);
  await login(a);
  await save(false, [other]);
  await save(false, []);
  await login(a, 'admin@example.test');
  await db.query("update platform_config set work_combination_prompt='' where id=1");
  await db.exec('reset role');
  await db.exec(migration); // Reapply without erasing the administrator's edits.
  assert.deepEqual((await db.query('select system_prompt,theme_prompt,work_combination_prompt from platform_config')).rows[0], { system_prompt: 'untouched system', theme_prompt: 'untouched theme', work_combination_prompt: '' });
  await db.exec("select set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claim.email','',false); set role anon;");
  assert.equal((await db.query('select * from sessions')).rows.length, 0);
  assert.equal((await db.query("update platform_config set work_combination_prompt='anonymous' where id=1 returning id")).rows.length, 0);
  console.log('Work combination DB: defaults, priority order, validation, RLS, revoked/deleted works, admin edits and repeatable migration passed.');
} finally {
  await db.close();
}
