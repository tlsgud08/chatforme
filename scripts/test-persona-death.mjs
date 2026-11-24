import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'vite';

const db = new PGlite();
const migration = file => readFileSync(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8');
const ids = Array.from({ length: 10 }, (_, i) => '00000000-0000-0000-0000-' + String(i + 1).padStart(12, '0'));
const [owner, outsider, room, first, second, third, message, firstRequest, secondRequest] = ids;
const query = async (sql, args = []) => (await db.query(sql, args)).rows;
const rpc = async (name, args) => (await query(
  'select public.' + name + '(' + args.map((_, i) => '$' + (i + 1)) + ') value', args,
))[0]?.value;
const login = async user => {
  await db.exec('reset role');
  await query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec('set role authenticated');
};

const description = '  First PC\n{{sync_date::preserve}}  \n';
const fence = String.fromCharCode(96).repeat(3);
const status = fence + 'status\nHealth: 0\n~~~\n' + fence;
const content = '회상\n\n' + status + '\n\n' + fence + '\nAnother block\n' + fence;
let recorded;

try {
  await db.exec(
    'create role anon; create role authenticated; create schema auth;'
    + "create function auth.uid() returns uuid language sql stable as $$select current_setting('request.jwt.claim.sub',true)::uuid$$;"
    + 'grant usage on schema auth,public to authenticated;'
    + "create table platform_config(id integer primary key, system_prompt text); insert into platform_config values(1,'original system');"
    + 'create table personas(id uuid primary key,user_id uuid,name text,description text);'
    + "create table sessions(id uuid primary key,user_id uuid,persona_id uuid,multichat_room_id uuid,summary text default '',summary_last_turn integer default 0);"
    + 'create table messages(id uuid primary key,session_id uuid,role text,content text,turn_index integer,created_at timestamptz default now(),'
    + 'content_version integer default 0,is_active_variant boolean default true,is_hidden boolean default false,reroll_group_id uuid,reroll_index integer,'
    + "input_tokens integer,output_tokens integer,cost numeric,cache_read_tokens integer,cache_write_tokens integer,is_summarized boolean,generation_status text default 'complete',"
    + 'command_id uuid,command_name text,command_prompt text);'
    + 'grant select,update on all tables in schema public to authenticated;'
    + 'create function is_settings_admin() returns boolean language sql stable as $$select auth.uid()::text = ' + "'" + owner + "'" + '$$;'
    + 'create function save_admin_settings(previous jsonb,desired jsonb,new_master_password text) returns boolean language plpgsql as $$'
    + "begin update platform_config set system_prompt=desired->>'system_prompt' where id=1; return true; end $$;"
    + 'create function recover_expired_session_responses(uuid) returns integer language sql as $$select 0$$;',
  );
  const baseline = migration('20261025051847_chat_and_editor_recovery.sql')
    .match(/create or replace function public\.session_response_context_hash[\s\S]+?\$\$;/)[0];
  await db.exec(baseline);
  await db.exec(migration('20261026002443_generation_context_single_pass.sql'));
  await query("insert into personas values($1,$2,'Former',$3),($4,$2,'Second','Second PC'),($5,$2,'Current','Current PC')",
    [first, owner, description, second, third]);
  await query('insert into sessions(id,user_id,persona_id) values($1,$2,$3)', [room, owner, first]);
  await query("insert into messages(id,session_id,role,content,turn_index) values($1,$2,'assistant',$3,0)", [message, room, content]);
  await login(owner);
  const before = await rpc('session_generation_context', [room]);
  await db.exec('reset role');
  await db.exec(migration('20261124155642_persona_deaths.sql'));
  await login(owner);
  assert.deepEqual(await rpc('session_generation_context', [room]), before, 'the unused generation context and hash are exact');
  await assert.rejects(() => rpc('record_session_persona_death', [room, first, second, firstRequest, 'memo', status, message, 99]), /메시지가 변경/);
  await query("update messages set generation_status='streaming' where id=$1", [message]);
  await assert.rejects(() => rpc('record_session_persona_death', [room, first, second, firstRequest, 'memo', status, message, 0]), /생성/);
  await query("update messages set generation_status='complete' where id=$1", [message]);
  const result = await rpc('record_session_persona_death', [room, first, second, firstRequest, 'memo', status, message, 0]);
  assert.equal(result.persona.id, second);
  assert.deepEqual(result.deaths, [{ persona_id: first, persona_name: 'Former', persona_description: description, status_block: status, death_note: 'memo' }]);
  assert.deepEqual(await rpc('record_session_persona_death', [room, first, second, firstRequest, 'memo', status, message, 0]), result);
  const after = await rpc('session_generation_context', [room]);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.summary, before.summary);
  assert.notEqual(after.contextHash, before.contextHash);
  await assert.rejects(() => query('update sessions set persona_id=$1 where id=$2', [first, room]), /다시 선택/);
  await query("update personas set description='edited' where id=$1", [first]);
  await query("update messages set content='edited' where id=$1", [message]);
  const twice = await rpc('record_session_persona_death', [room, second, third, secondRequest, '', null, null, null]);
  assert.deepEqual(twice.deaths.map(death => death.persona_id), [first, second]);
  assert.deepEqual(twice.deaths[0], result.deaths[0]);
  assert.equal(twice.persona.id, third);
  assert.equal(await rpc('save_admin_settings_with_persona_death', [{}, { system_prompt: 'updated' }, null, '', 'Admin rules']), true);
  await assert.rejects(() => rpc('save_admin_settings_with_persona_death', [{}, { system_prompt: 'stale' }, null, '', 'Stale rules']), /변경/);
  recorded = (await rpc('session_generation_context', [room])).personaDeaths;
  assert.equal(recorded.prompt, 'Admin rules');
  await login(outsider);
  assert.deepEqual(await query('select * from session_persona_deaths'), []);
  assert.equal(await rpc('session_persona_death_context', [room]), null);
  await assert.rejects(() => rpc('record_session_persona_death', [room, third, null, ids[9], '', null, null, null]), /채팅방/);
  await assert.rejects(() => rpc('save_admin_settings_with_persona_death', [{}, {}, null, 'Admin rules', 'forged']), /관리자/);
} finally { await db.close(); }

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { applyPersonaDeaths, DEFAULT_PERSONA_DEATH_PROMPT } = await server.ssrLoadModule('/src/lib/personaDeathPrompt.ts');
  const { deathStatusChoices } = await server.ssrLoadModule('/src/lib/personaDeath.ts');
  const { buildOpenRouterMessages } = await server.ssrLoadModule('/src/lib/llm/promptCache.ts');
  const choices = deathStatusChoices([{ id: message, content, content_version: 4, turn_index: 1 }]);
  assert.equal(choices.length, 2);
  assert.equal(choices[1].raw, status);
  assert.equal(choices[1].messageVersion, 4);
  assert.equal(deathStatusChoices([{ content, content_version: 0, is_active_variant: false }]).length, 0);
  const base = {
    systemParts: { core: 'core', persona: 'Current', userNote: 'note', summary: 'summary', storyNotes: 'story', keywords: 'keywords' },
    messages: [{ role: 'user', content: 'history' }, { role: 'assistant', content: 'answer', cacheBreakpoint: true }, { role: 'user', content: 'continue' }],
  };
  assert.equal(applyPersonaDeaths(base, null), base);
  assert.equal(applyPersonaDeaths(base, { ...recorded, deaths: [] }), base);
  const withDeaths = applyPersonaDeaths(base, recorded);
  const wire = buildOpenRouterMessages({ ...withDeaths, model: 'fixture/model' });
  const oldWire = buildOpenRouterMessages({ ...base, model: 'fixture/model' });
  assert.deepEqual(wire.slice(1), oldWire.slice(1), 'history, cache markers and user input are unchanged');
  assert.equal(wire[0].content, oldWire[0].content + '\n\n' + withDeaths.systemParts.personaDeaths);
  for (const text of [description, status, 'Admin rules', 'Second PC']) assert.ok(wire[0].content.includes(text));
  assert.ok(applyPersonaDeaths(base, { ...recorded, prompt: ' ' }).systemParts.personaDeaths.includes(DEFAULT_PERSONA_DEATH_PROMPT));
  console.log('Persona deaths: atomic snapshots and handoff, retries, ownership, administrator rules, exact source text and unchanged ordinary payload passed.');
} finally { await server.close(); }
