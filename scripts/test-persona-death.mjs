import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
let recorded, livingContext, playingContext;

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
  await db.exec(`reset role;
    alter table sessions add column title text default 'Fixture', add column created_at timestamptz default now(),
      add column updated_at timestamptz default now(), add column is_archived boolean default false,
      add column total_input_tokens integer, add column total_output_tokens integer, add column total_cost numeric,
      add column prompt_cache_message_id uuid;
    alter table messages add column legacy_turn_conflict boolean default false, add column usage_accounted boolean default false,
      add column generation_context_hash text;
    create table summary_versions(session_id uuid, content text, summarized_through_turn integer, is_active boolean,
      input_tokens integer, output_tokens integer, cost numeric, created_at timestamptz,
      narrative_target_chars integer, narrative_target_enabled boolean, id uuid);
    create table story_notes(session_id uuid, content text, created_at timestamptz, updated_at timestamptz);
    create table multichat_rooms(id uuid);
    grant insert,delete on messages to authenticated;
  `);
  await db.exec(migration('20261025012314_atomic_session_branch.sql'));
  await db.exec(migration('20261104235318_prune_unselected_responses.sql'));
  await db.exec(migration('20261125151120_persona_archives.sql'));
  const recentTurnsMigration = readdirSync(new URL('../supabase/migrations/', import.meta.url))
    .find(filename => filename.endsWith('_persona_archive_recent_turns.sql'));
  assert.ok(recentTurnsMigration);
  await db.exec(migration(recentTurnsMigration));
  const [fourth, nextUser, nextAnswer, livingId, earlyFork, fullFork, nestedFork, editId, deleteId] =
    Array.from({ length: 9 }, () => crypto.randomUUID());
  await query("insert into personas values($1,$2,'Next','Next PC')", [fourth, owner]);
  await login(owner);
  const oldArchives = await rpc('session_persona_archive_context', [room]);
  assert.equal(oldArchives.archives[0].status_turn, 0, 'existing death records inherit their status turn');
  assert.equal(oldArchives.archives[0].status_block, status, 'existing edited messages do not rewrite the original snapshot');
  assert.equal(oldArchives.archives[0].is_living, false);
  assert.equal((await rpc('session_persona_status_turn', [room, 0]))[0].id, message, 'old rooms support direct turn lookup');
  assert.deepEqual(await rpc('session_persona_status_turn', [room, 1234]), []);
  const claimContext = await rpc('session_generation_context', [room]);
  const claim = await rpc('begin_session_response', [room, nextAnswer, nextUser, 'Third persona dialogue', null, null, null,
    [], '', 0, null, 1, 1, claimContext.contextHash]);
  assert.equal(claim.userMessage.author_persona_id, third);
  await query("update messages set generation_status='complete',content=$2 where id=$1", [nextAnswer, content]);
  await login(outsider);
  assert.equal(await rpc('session_persona_archive_context', [room]), null);
  assert.deepEqual(await rpc('session_persona_status_turn', [room, 1]), []);
  await assert.rejects(() => rpc('branch_session_at_message', [room, nextAnswer, fullFork, 0]), /inaccessible/);
  const patch = { is_living: true, may_appear: true, image_url: 'https://example.test/portrait.png', note: 'Survives',
    status_action: 'replace', status_message: nextAnswer, status_version: 0,
    status_block: fence + '\nAnother block\n' + fence };
  const create = [room, third, 'create', livingId, null, fourth, patch];
  await assert.rejects(() => rpc('mutate_session_persona_archive', create), /채팅방/);
  await login(owner);
  const created = await rpc('mutate_session_persona_archive', create);
  assert.equal(created.persona.id, fourth);
  assert.deepEqual(await rpc('mutate_session_persona_archive', create), created);
  const current = await rpc('session_generation_context', [room]);
  assert.equal(current.personaDeaths.deaths.length, 2, 'old clients only get death records');
  assert.deepEqual(current.personaArchives.archives[2].past_lines, ['Third persona dialogue']);
  assert.equal(current.personaArchives.archives[2].status_turn, 1);
  assert.notEqual(current.contextHash, claimContext.contextHash);

  assert.equal(await rpc('branch_session_at_message', [room, message, earlyFork, 0]), earlyFork);
  const early = await rpc('session_persona_archive_context', [earlyFork]);
  assert.equal(early.persona.id, third);
  assert.deepEqual(early.archives.map(a => a.persona_id), [first, second], 'a later archive does not change an earlier scene');
  assert.equal(await rpc('branch_session_at_message', [room, nextAnswer, fullFork, 0]), fullFork);
  assert.equal(await rpc('branch_session_at_message', [room, nextAnswer, fullFork, 0]), fullFork);
  const fork = await rpc('session_persona_archive_context', [fullFork, true]);
  assert.deepEqual(fork.archives, current.personaArchives.archives, 'the fork retains both kinds of archives, snapshots, image and voice');
  const [ref] = await query('select status_message_id from session_persona_deaths where session_id=$1 and persona_id=$2', [fullFork, third]);
  assert.notEqual(ref.status_message_id, nextAnswer);
  assert.equal(await rpc('branch_session_at_message', [fullFork, ref.status_message_id, nestedFork, 0]), nestedFork);
  assert.deepEqual((await rpc('session_persona_archive_context', [nestedFork, true])).archives, fork.archives);

  const edit = [fullFork, third, 'edit', editId, livingId, null,
    { ...patch, is_living: false, note: 'Corrected to deceased', status_action: 'keep' }];
  const edited = await rpc('mutate_session_persona_archive', edit);
  assert.equal(edited.archives[2].is_living, false);
  assert.equal(edited.archives[2].may_appear, false);
  assert.equal(edited.archives[2].image_url, null);
  assert.equal(edited.archives[2].status_block, patch.status_block);
  assert.notEqual((await rpc('session_generation_context', [fullFork])).contextHash, current.contextHash);
  await assert.rejects(() => rpc('mutate_session_persona_archive', [fullFork, third, 'delete', deleteId, livingId, null, null]), /변경/);
  const remove = [fullFork, third, 'delete', deleteId, editId, null, null];
  assert.equal((await rpc('mutate_session_persona_archive', remove)).archives.length, 2);
  assert.equal((await rpc('mutate_session_persona_archive', remove)).persona.id, fourth);
  await query('update sessions set persona_id=$1 where id=$2', [third, fullFork]);
  assert.equal((await rpc('session_persona_archive_context', [room])).archives[2].is_living, true);
  assert.equal(await rpc('save_admin_settings_with_persona_archives',
    [{}, { system_prompt: 'updated again' }, null, 'Admin rules', 'Updated death rules', '', 'Custom living rules']), true);
  assert.equal((await rpc('session_persona_archive_context', [room])).livingPrompt, 'Custom living rules');
  assert.equal((await rpc('session_persona_archive_context', [room])).deathPrompt, 'Updated death rules');
  livingContext = current.personaArchives;
  await db.exec(`reset role;
    create table profiles(id uuid primary key);
    alter table profiles enable row level security;
    create policy profile_owner on profiles for all to authenticated using (id = auth.uid()) with check (id = auth.uid());
    grant select,update on profiles to authenticated;
  `);
  await query('insert into profiles values($1),($2)', [owner, outsider]);
  const transitionMigrations = readdirSync(new URL('../supabase/migrations/', import.meta.url))
    .filter(filename => /_persona_transition_(columns|functions|archives|generation)\.sql$/.test(filename)).sort();
  assert.equal(transitionMigrations.length, 4);
  for (const filename of transitionMigrations) await db.exec(migration(filename));
  const [legacyRoom, legacyUser, noticeUser, noticeAnswer, rearchiveId] = Array.from({length: 5}, () => crypto.randomUUID());
  await query('insert into sessions(id,user_id,persona_id) values($1,$2,$3)', [legacyRoom, owner, first]);
  await query("insert into messages(id,session_id,role,content,turn_index) values($1,$2,'user','Legacy user turn',1)", [legacyUser, legacyRoom]);

  await login(owner);
  assert.deepEqual((await rpc('session_persona_turn_context', [room])).notice,
    {from: 'Current', to: 'Next', template: ''});
  await query('update sessions set persona_id=$1 where id=$2', [third, room]);
  const returned = await rpc('session_persona_archive_context', [room]);
  assert.equal(returned.persona.id, third, 'a living archived character is selectable again');
  assert.equal(returned.archives[2].is_living, true, 'playing preserves living archive');
  assert.equal((await rpc('session_persona_turn_context', [room])).notice, null, 'back to the previous turn PC does not insert a notice');
  await assert.rejects(() => query('update sessions set persona_id=$1 where id=$2', [second, room]), /사망 보관/);
  await assert.rejects(() => rpc('mutate_session_persona_archive', [room, third, 'edit', crypto.randomUUID(), livingId, null,
    { ...patch, is_living: false, status_action: 'keep' }]), /플레이 중/);
  assert.equal((await rpc('mutate_session_persona_archive', [room, third, 'create', rearchiveId, livingId, fourth,
    { ...patch, status_action: 'keep' }])).archives.filter(a => a.persona_id === third).length, 1);
  const fromFourth = await rpc('mutate_session_persona_archive', [room, fourth, 'create', crypto.randomUUID(), null, third,
    { ...patch, status_action: 'remove' }]);
  assert.equal(fromFourth.persona.id, third, 'an archived living character also works in the handoff selector');

  await query('update sessions set persona_id=$1 where id=$2', [second, legacyRoom]);
  await query('update sessions set persona_id=$1 where id=$2', [fourth, legacyRoom]);
  const legacyContext = await rpc('session_generation_context', [legacyRoom]);
  assert.deepEqual(legacyContext.personaTurn.notice, {from: 'Former', to: 'Next', template: ''}, 'one notice from last actual turn to the final selection');
  assert.equal((await query('select content from messages where id=$1', [legacyUser]))[0].content, 'Legacy user turn');
  const args = [legacyRoom, noticeAnswer, noticeUser, 'Player text\n\n*Transition text*', null, null, null,
    [], '', 0, null, 2, 1, legacyContext.contextHash, fourth];
  await assert.rejects(() => rpc('begin_session_response', [...args.slice(0,-1), second]), /Persona changed/);
  const noticeClaim = await rpc('begin_session_response', args);
  assert.equal(noticeClaim.userMessage.content, 'Player text\n\n*Transition text*');
  assert.equal(noticeClaim.userMessage.author_persona_name, 'Next');
  assert.equal((await rpc('session_persona_turn_context', [legacyRoom])).notice, null, 'the saved turn consumes the transition');
  assert.equal((await rpc('begin_session_response', args)).userMessage.id, noticeUser, 'a retry does not attach the message again');
  await query("update messages set content='Edited ordinary text' where id=$1", [noticeUser]);
  await query("update messages set generation_status='complete' where id=$1", [noticeAnswer]);
  assert.equal((await query('select content from messages where id=$1', [noticeUser]))[0].content, 'Edited ordinary text');
  await query('update sessions set persona_id=$1 where id=$2', [first, legacyRoom]);
  assert.equal((await rpc('session_persona_turn_context', [legacyRoom])).notice.from, 'Next');
  await query('update profiles set persona_transition_notice_enabled=false where id=$1', [owner]);
  assert.equal((await rpc('session_persona_turn_context', [legacyRoom])).notice, null);
  await query('update profiles set persona_transition_notice_enabled=true where id=$1', [owner]);
  const adminArgs = [{}, {system_prompt:'transition settings'}, null, 'Updated death rules', 'Updated death rules',
    'Custom living rules', 'Custom living rules', '', '{이전} → {현재}'];
  assert.equal(await rpc('save_admin_settings_with_persona_transition', adminArgs), true);
  assert.equal((await rpc('session_persona_turn_context', [legacyRoom])).notice.template, '{이전} → {현재}');
  await login(outsider);
  assert.equal(await rpc('session_persona_turn_context', [legacyRoom]), null);
  await assert.rejects(() => rpc('save_admin_settings_with_persona_transition', adminArgs), /관리자/);
  await db.exec('reset role');
  await query(`insert into messages(id,session_id,role,content,turn_index,author_persona_id)
    select gen_random_uuid(),$1,'user','Past PC turn ' || n,n,$2
    from generate_series(2,24) n`, [room, third]);
  for (const [index, text, speaker] of [
    [25, '*이어서 계속 진행*', third],
    [26, '*이어서 계속 진행*\n\n*누리 → 마루*', third],
    [27, 'Other persona turn', fourth],
    [28, '*이어서 계속 진행*이라고 말하며 문을 열었다.', third],
  ]) {
    await query(`insert into messages(id,session_id,role,content,turn_index,author_persona_id)
      values(gen_random_uuid(),$1,'user',$2,$3,$4)`, [room, text, index, speaker]);
  }
  await login(owner);
  const history = (await rpc('session_generation_context', [room])).personaArchives.archives.find(a => a.persona_id === third);
  assert.deepEqual(history.past_lines, [
    ...Array.from({ length: 19 }, (_, i) => 'Past PC turn ' + (i + 6)),
    '*이어서 계속 진행*이라고 말하며 문을 열었다.',
  ], 'recent 20 starts after filtering auto-continue turns, preserves chronology and keeps real text');
  playingContext = returned;
} finally { await db.close(); }

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { applyPersonaArchives, applyPersonaDeaths, DEFAULT_PERSONA_DEATH_PROMPT, statusTurnLabel } = await server.ssrLoadModule('/src/lib/personaDeathPrompt.ts');
  const { appendPersonaTransition } = await server.ssrLoadModule('/src/lib/personaTransition.ts');
  const { deathStatusChoices } = await server.ssrLoadModule('/src/lib/personaDeath.ts');
  const { buildOpenRouterMessages } = await server.ssrLoadModule('/src/lib/llm/promptCache.ts');
  const choices = deathStatusChoices([{ id: message, content, content_version: 4, turn_index: 1 }]);
  assert.equal(choices.length, 2);
  assert.equal(choices[1].raw, status);
  assert.equal(choices[0].preview, 'Another block', 'the bottommost code block wins');
  assert.equal(statusTurnLabel(1), '상태창 01턴');
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
  assert.equal(appendPersonaTransition('안녕하세요.', {from:'누리',to:'마루',template:''}),
    '안녕하세요.\n\n*페르소나(플레이어 캐릭터)가 누리에서 마루로 전환되었습니다. 해당 사실을 반영하여 진행해 주세요.*');
  assert.equal(appendPersonaTransition('', {from:'누리',to:'마루',template:'{이전} → {현재}'}), '*누리 → 마루*');
  assert.equal(appendPersonaTransition('원문', null), '원문');
  assert.ok(!applyPersonaArchives(base, playingContext).systemParts.personaDeaths.includes('Living Persona Archives'),
    'playing an archived character suppresses its archived NPC instructions');
  const withLiving = applyPersonaArchives(base, livingContext).systemParts.personaDeaths;
  assert.ok(withLiving.includes('Current의 이미지: ![](https://example.test/portrait.png)'));
  assert.ok(withLiving.includes('해당 인물의 과거 발화·행동 (참고하여 진행)\n~~~\nThird persona dialogue\n~~~'));
  const mentionsOnly = applyPersonaArchives(base, { ...livingContext, archives: livingContext.archives.map(a => ({...a, may_appear: false})) }).systemParts.personaDeaths;
  assert.ok(mentionsOnly.includes('직접 등장·대사·행동은 금지'));
  assert.ok(!mentionsOnly.includes('portrait.png') && !mentionsOnly.includes('Third persona dialogue'));
  console.log('Persona archives: atomic snapshots and handoff, retries, ownership, administrator rules, exact source text and unchanged ordinary payload passed.');
} finally { await server.close(); }
