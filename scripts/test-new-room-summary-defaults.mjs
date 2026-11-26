import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const migrations = new URL('../supabase/migrations/', import.meta.url);
const migration = readdirSync(migrations).find(name => name.endsWith('_normalize_new_room_summary_defaults.sql'));
const owner = '00000000-0000-0000-0000-000000000001';
const work = '00000000-0000-0000-0000-000000000002';
const settings = 'summary_level_override, summary_allow_omission_override, summary_source_mode_override';
const defaults = { summary_level_override: 0, summary_allow_omission_override: false, summary_source_mode_override: 'full' };

try {
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select '${owner}'::uuid $$;
    create table profiles(id uuid primary key, summary_model text, default_model text, summary_reasoning jsonb,
      summary_level int, summary_allow_omission boolean, summary_parameters_enabled boolean,
      summary_narrative_target_tokens text, summary_narrative_target_chars text, summary_source_mode text);
    create table works(id uuid primary key, title text);
    create table start_configs(id uuid, work_id uuid, is_default boolean, sort_order int, initial_context text, initial_message text);
    create table personas(id uuid, user_id uuid);
    create table sessions(id uuid primary key default gen_random_uuid(), user_id uuid, work_id uuid,
      title text, persona_id uuid, start_config_id uuid, summary_model_override text, summary_reasoning_override jsonb,
      summary_level_override int, summary_allow_omission_override boolean, summary_parameters_enabled_override boolean,
      summary_narrative_target_tokens_override text, summary_narrative_target_chars_override text, summary_source_mode_override text,
      multichat_room_id uuid, model_override text, output_tokens_override int, output_settings_override_enabled boolean);
    create table multichat_rooms(id uuid primary key, host_user_id uuid, work_id uuid, title text, model text, output_tokens int);
    insert into profiles(id, summary_level, summary_allow_omission, summary_source_mode) values('${owner}', 5, true, 'incremental');
    insert into works values('${work}', 'Fixture');
    insert into sessions(id, ${settings}) values('${work}', 5, true, 'incremental');
  `);
  await db.exec(readFileSync(new URL(migration, migrations), 'utf8'));
  await db.exec('create trigger create_multichat after insert on multichat_rooms for each row execute function multichat_create_session()');
  const readSettings = async id => (await db.query(`select ${settings} from sessions where id=$1`, [id])).rows[0];
  const createRoom = async () => (await db.query('select create_session_with_start($1) as id', [work])).rows[0].id;
  assert.deepEqual(await readSettings(await createRoom()), defaults);
  const multi = '00000000-0000-0000-0000-000000000003';
  await db.query("insert into multichat_rooms values($1,$2,$3,'Fixture',null,null)", [multi, owner, work]);
  assert.deepEqual(await readSettings(multi), defaults);
  assert.deepEqual(await readSettings(work), { summary_level_override: 5, summary_allow_omission_override: true, summary_source_mode_override: 'incremental' });
  assert.deepEqual((await db.query('select summary_level, summary_allow_omission, summary_source_mode from profiles')).rows[0],
    { summary_level: 5, summary_allow_omission: true, summary_source_mode: 'incremental' });
  await db.exec("update profiles set summary_source_mode='full'");
  assert.deepEqual(await readSettings(await createRoom()), defaults, 'older profiles also used full source with the old level and omission defaults');
  await db.exec("update profiles set summary_level=3, summary_source_mode='incremental'");
  assert.deepEqual(await readSettings(await createRoom()), { summary_level_override: 3, summary_allow_omission_override: true, summary_source_mode_override: 'incremental' });
  console.log('New-room summary defaults: solo and multiplayer creation, legacy profiles, unchanged existing rooms and custom preferences passed.');
} finally {
  await db.close();
}
