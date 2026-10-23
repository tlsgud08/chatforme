import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const [owner, author, outsider, main, extra, third, privateWork, room, mainTheme, extraTheme, ownTheme, privateTheme, thirdTheme, globalTheme] = Array.from({ length: 14 }, (_, i) => id(i + 1));
const dir = new URL('../supabase/migrations/', import.meta.url);
const migration = suffix => readFileSync(new URL(readdirSync(dir).find(name => name.endsWith(suffix)), dir), 'utf8');
async function login(user) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.email','user@example.test',false)", [user]);
  await db.exec('set role authenticated');
}
const state = async () => (await db.query('select * from sessions where id=$1', [room])).rows[0];
const combine = (enabled, ids) => db.query('update sessions set work_combination_enabled=$1,combined_work_ids=$2::uuid[] where id=$3', [enabled, ids, room]);
const select = (theme, mode = null, period = null) => db.query('update sessions set theme_id=$1,theme_override=$2,theme_variant=$3,theme_period=$4,auto_theme_enabled=$5 where id=$6', [theme, mode, 'light', period, mode === null, room]);
try {
  await db.exec(`
    create role authenticated; create role anon;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.email() returns text language sql stable as $$select current_setting('request.jwt.claim.email',true)$$;
    create table profiles(id uuid primary key);
    create table works(id uuid primary key,creator_id uuid,visibility text);
    create table sessions(id uuid primary key,user_id uuid,work_id uuid,title text default 'original');
    create table commands(id uuid primary key,owner_id uuid,name text,is_published boolean default false);
    create table platform_config(id integer primary key,system_prompt text);
    create function can_edit_work(w uuid) returns boolean language sql stable security invoker as $$select exists(select 1 from works where id=w and creator_id=auth.uid())$$;
    alter table works enable row level security;
    alter table profiles enable row level security;
    alter table sessions enable row level security;
    alter table platform_config enable row level security;
    create policy works_read on works for select using(visibility in ('public','unlisted') or creator_id=auth.uid());
    create policy works_edit on works for update using(creator_id=auth.uid()) with check(creator_id=auth.uid());
    create policy profiles_own on profiles for all using(id=auth.uid()) with check(id=auth.uid());
    create policy sessions_own on sessions for all using(user_id=auth.uid()) with check(user_id=auth.uid());
    create policy config_read on platform_config for select using(true);
    grant usage on schema public,auth to authenticated,anon;
    insert into profiles values('${owner}'),('${author}'),('${outsider}');
    insert into works values('${main}','${owner}','public'),('${extra}','${author}','public'),('${third}','${author}','unlisted'),('${privateWork}','${author}','private');
    insert into sessions values('${room}','${owner}','${main}','original');
    insert into platform_config values(1,'unchanged');
  `);
  for (const suffix of ['0039_work_themes_and_commands.sql', '0040_theme_command_integrity.sql',
    '_automatic_work_themes.sql', '_theme_secondary_text.sql', '_theme_secondary_opacity.sql', '_fluid_chat_theme.sql',
    '_day_night_work_themes.sql', '_stale_day_night_branch_recovery.sql', '_time_theme_conditions.sql',
    '_disable_night_mode_for_dark_preference.sql', '_optional_day_night_variants.sql', '_session_work_combination.sql']) {
    await db.exec(migration(suffix));
  }
  await db.exec('grant select,insert,update,delete on all tables in schema public to authenticated,anon;');
  const palette = { accent: '#123456', accentText: '#ffffff', main: '#101010', mainText: '#eeeeee' };
  for (const [theme, work, user, shared, name] of [[mainTheme, main, owner, true, '궁궐'], [extraTheme, extra, author, true, '궁궐'], [ownTheme, extra, owner, false, '내 궁궐'], [privateTheme, extra, outsider, false, '비밀 궁궐'], [thirdTheme, third, author, true, '궁궐'], [globalTheme, null, owner, false, '전역']]) {
    await db.query('insert into themes(id,work_id,owner_id,work_shared,name,dark_colors,light_colors) values($1,$2,$3,$4,$5,$6,$6)', [theme, work, user, shared, name, JSON.stringify(palette)]);
  }
  await db.query('update works set default_theme_id=$1,default_theme_variant=$2 where id=$3', [mainTheme, 'light', main]);
  const snapshot = (await db.query('select * from themes order by id')).rows;
  const before = await state();
  await db.exec(migration('_combined_work_themes.sql'));
  assert.deepEqual((await db.query('select * from themes order by id')).rows, snapshot);
  assert.deepEqual(await state(), before, 'installing the migration must not change an existing room');
  assert.ok((await db.query("select prosecdef from pg_proc where proname in ('validate_theme_reference','guard_session_theme_period')")).rows.every(row => !row.prosecdef));

  await login(owner);
  await assert.rejects(() => select(extraTheme), /not available/);
  await combine(false, [extra]);
  await assert.rejects(() => select(extraTheme), /not available/);
  await combine(true, []);
  await assert.rejects(() => select(extraTheme), /not available/);
  await combine(true, [extra, third]);
  await select(extraTheme, 'custom');
  assert.equal((await state()).theme_id, extraTheme);
  await select(ownTheme);
  assert.equal((await state()).theme_id, ownTheme);
  await assert.rejects(() => select(privateTheme), /not available/);
  assert.equal((await db.query('select id from themes where id=$1', [privateTheme])).rows.length, 0);
  await combine(true, [extra]);
  await assert.rejects(() => select(thirdTheme), /not available/);
  await select(globalTheme, 'custom');
  await assert.rejects(() => db.query('update profiles set preferred_theme_id=$1 where id=$2', [extraTheme, owner]), /Personal default/);
  await assert.rejects(() => db.query('update works set default_theme_id=$1 where id=$2', [extraTheme, main]), /not available/);

  await db.query('update sessions set theme_day_night_enabled=true where id=$1', [room]);
  await select(extraTheme, null, 'night');
  assert.equal((await state()).theme_period, 'night', 'extra dual themes must retain their night state');
  await combine(true, [third, extra]);
  assert.equal((await state()).theme_id, extraTheme);
  assert.equal((await state()).theme_period, 'night', 'reordering does not change the scene');
  await combine(true, [extra]);
  assert.equal((await state()).theme_period, 'night', 'removing a different work does not change the scene');
  const branch = id(100);
  await db.query(`insert into sessions(id,user_id,work_id,theme_id,theme_variant,theme_day_night_enabled,theme_period,work_combination_enabled,combined_work_ids)
    values($1,$2,$3,$4,'light',true,'night',true,$5::uuid[])`, [branch, owner, main, extraTheme, [extra]]);
  assert.equal((await db.query('select theme_period from sessions where id=$1', [branch])).rows[0].theme_period, 'night');
  await combine(false, [extra]);
  let current = await state();
  assert.deepEqual([current.theme_override, current.theme_id, current.theme_variant, current.theme_period, current.auto_theme_enabled], [null, null, null, null, true]);
  assert.deepEqual(current.combined_work_ids, [extra], 'disable retains the list while resetting an unavailable scene');
  await assert.rejects(() => select(extraTheme), /not available/);
  await combine(true, [extra]);
  await select(extraTheme, 'custom');
  await combine(true, []);
  assert.equal((await state()).theme_override, null, 'removing the last additional work also recovers fixed scenes');
  await select(mainTheme, 'custom');
  await combine(false, [extra]);
  assert.equal((await state()).theme_id, mainTheme, 'main and global fixed choices are unaffected');

  await combine(true, [extra]);
  await select(extraTheme);
  await db.exec('reset role');
  await db.query('update themes set use_day_night_variants=false where id=$1', [extraTheme]);
  await login(owner);
  await select(extraTheme, null, 'night');
  assert.equal((await state()).theme_period, null);
  await db.exec('reset role');
  await db.query('update themes set use_day_night_variants=true,light_colors=null where id=$1', [extraTheme]);
  await login(owner);
  await select(extraTheme, null, 'night');
  assert.equal((await state()).theme_period, null, 'single extra themes cannot retain a stale period');
  await db.query("update profiles set preferred_theme_mode='dark' where id=$1", [owner]);
  assert.equal((await state()).theme_day_night_enabled, false);
  await db.query("update profiles set preferred_theme_mode='light' where id=$1", [owner]);
  await select(ownTheme);
  await db.exec('reset role');
  await db.query("update works set visibility='private' where id=$1", [extra]);
  await login(owner);
  assert.equal((await db.query('select id from themes where id=$1', [ownTheme])).rows.length, 1, 'own theme remains readable, so work access must be checked separately');
  await select(mainTheme);
  await assert.rejects(() => select(ownTheme), /not available/);
  await db.exec('reset role');
  await db.query("update works set visibility='public' where id=$1", [extra]);
  await login(owner);
  await select(ownTheme);
  await db.exec('reset role');
  await db.query("update works set visibility='private' where id=$1", [extra]);
  await login(owner);
  await db.query("update sessions set title='still editable' where id=$1", [room]);
  await combine(false, [extra]);
  assert.equal((await state()).theme_id, null, 'revoked work access must never block disabling');
  await db.exec('reset role');
  await db.query("update works set visibility='public' where id=$1", [extra]);
  await login(owner);
  await combine(true, [extra]);
  await select(extraTheme, 'custom');
  await db.exec('reset role');
  await db.query('delete from themes where id=$1', [extraTheme]);
  await login(owner);
  assert.equal((await state()).theme_id, null, 'theme deletion must preserve FK recovery');
  assert.equal((await state()).theme_override, null);

  await login(outsider);
  assert.equal((await db.query('select * from sessions where id=$1', [room])).rows.length, 0);
  assert.equal((await db.query('update sessions set work_combination_enabled=false where id=$1 returning id', [room])).rows.length, 0);
  await db.exec('reset role');
  const stable = (await db.query('select * from sessions order by id')).rows;
  await db.exec(migration('_combined_work_themes.sql'));
  assert.deepEqual((await db.query('select * from sessions order by id')).rows, stable, 'reapplying the migration preserves saved settings');
  await db.exec("select set_config('request.jwt.claim.sub','',false);set role anon;");
  assert.equal((await db.query('select * from sessions')).rows.length, 0);
  console.log('Combined theme DB: real RLS, active-only scope, shared/private themes, same-name themes, fixed/fluid selection, night/opt-out/single guards, branching, atomic removal/disable, revocation, deletion and repeatable migration passed.');
} finally {
  await db.close();
}
