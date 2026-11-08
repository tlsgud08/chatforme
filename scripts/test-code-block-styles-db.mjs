import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../supabase/migrations/20261108145957_status_codeblock_styles.sql', import.meta.url), 'utf8');
const db = new PGlite();
const owner = '10000000-0000-0000-0000-000000000001';
const stranger = '10000000-0000-0000-0000-000000000002';
try {
  await db.exec(`
    create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    create table profiles(id uuid primary key, marker text);
    create table sessions(id uuid primary key, user_id uuid not null, body text);
    create table themes(id uuid primary key, owner_id uuid not null, colors jsonb);
    insert into profiles values('${owner}','original');
    insert into sessions values('${owner}','${owner}','untouched conversation');
    insert into themes values('${owner}','${owner}','{"main":"#123456"}');
    alter table profiles enable row level security;
    alter table sessions enable row level security;
    alter table themes enable row level security;
    create policy own_profile on profiles to authenticated using(id=auth.uid()) with check(id=auth.uid());
    create policy own_session on sessions to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
    create policy own_theme on themes to authenticated using(owner_id=auth.uid()) with check(owner_id=auth.uid());
    grant select,update on profiles,sessions,themes to authenticated;
  `);
  await db.exec(migration);
  await db.exec(migration);
  assert.deepEqual((await db.query('select marker,use_legacy_status from profiles')).rows, [{ marker: 'original', use_legacy_status: false }]);
  assert.deepEqual((await db.query('select body,use_theme_code_block,code_block_style from sessions')).rows,
    [{ body: 'untouched conversation', use_theme_code_block: true, code_block_style: null }]);
  assert.deepEqual((await db.query('select colors,code_block_style from themes')).rows,
    [{ colors: { main: '#123456' }, code_block_style: 'basic' }]);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${owner}';`);
  for (const value of ['basic','legacy','neon','corporate','hanji','scroll','grimoire','noir','notebook']) {
    assert.equal((await db.query('update themes set code_block_style=$1 returning code_block_style', [value])).rows[0].code_block_style, value);
    assert.equal((await db.query('update sessions set use_theme_code_block=false,code_block_style=$1 returning code_block_style', [value])).rows[0].code_block_style, value);
  }
  await db.exec('update profiles set use_legacy_status=true');
  await db.exec('update sessions set use_theme_code_block=true');
  assert.equal((await db.query('select code_block_style from sessions')).rows[0].code_block_style, 'notebook', 're-enabling inheritance retains the last room choice');
  for (const table of ['themes','sessions']) {
    await assert.rejects(db.query(`update ${table} set code_block_style=$1`, ['space']), /check constraint/);
  }
  await db.exec(`set request.jwt.claim.sub='${stranger}';`);
  for (const table of ['profiles','sessions','themes']) {
    assert.equal((await db.query(`select * from ${table}`)).rows.length, 0, 'existing row visibility stays private');
  }
  assert.equal((await db.query('update profiles set use_legacy_status=false returning id')).rows.length, 0);
  assert.equal((await db.query("update sessions set code_block_style='legacy' returning id")).rows.length, 0);
  assert.equal((await db.query("update themes set code_block_style='legacy' returning id")).rows.length, 0);
  await db.exec('reset role');
  assert.equal((await db.query('select use_legacy_status from profiles')).rows[0].use_legacy_status, true);
  console.log('Status preferences DB: additive/idempotent migration, unchanged content/palettes, nine valid styles, persistent room choice and unchanged owner RLS passed.');
} finally { await db.close(); }
