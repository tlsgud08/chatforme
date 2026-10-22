import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const dir = new URL('../supabase/migrations/', import.meta.url);
const a='00000000-0000-0000-0000-000000000001', b='00000000-0000-0000-0000-000000000002';
const work='10000000-0000-0000-0000-000000000001', room='20000000-0000-0000-0000-000000000001';
const longRoom='20000000-0000-0000-0000-000000000002';
const sql = readFileSync(new URL('20261022094256_integrity_and_query_safety.sql',dir),'utf8');
const query = async (sql,params=[]) => (await db.query(sql,params)).rows;
async function login(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);
  await db.exec(id?'set role authenticated':'set role anon');
}
try {
  await db.exec(`create role authenticated; create role anon; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.email() returns text language sql stable as $$select 'fixture@example.test'::text$$;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');`);
  // Bootstrap the actual schema. Storage/auth password infrastructure is external
  // to this test; skip only those services and the historical deleting repair.
  for (const file of readdirSync(dir).filter(n=>/^00\d\d_/.test(n)).sort()) {
    if(file.startsWith('0012_')||file.startsWith('0032_'))continue;
    let source=readFileSync(new URL(file,dir),'utf8');
    if(file.startsWith('0003_follows')||file.startsWith('0008_'))source=source.split('insert into storage.buckets')[0];
    source=source.replace(/create extension if not exists pgcrypto;/gi,'');
    source=source.replace(/do \$\$ begin alter publication[\s\S]*?end \$\$;/gi,'');
    try { await db.exec(source); } catch(error) { throw new Error(file+': '+error.message); }
  }
  for (const file of readdirSync(dir).filter(n=>n.startsWith('2026')&&n<'20261022094256_integrity_and_query_safety.sql').sort()) {
    try { await db.exec(readFileSync(new URL(file,dir),'utf8')); } catch(error) { throw new Error(file+': '+error.message); }
  }
  await db.exec(`grant usage on schema public,auth to anon,authenticated;
    grant select,insert,update,delete on all tables in schema public to anon,authenticated;
    insert into auth.users(id,email) values('${a}','a@example.test'),('${b}','b@example.test');
    insert into works(id,creator_id,title,visibility) values('${work}','${a}','Original','private');
    insert into sessions(id,user_id,work_id) values('${room}','${a}','${work}'),('${longRoom}','${a}','${work}');
    insert into messages(session_id,role,content,turn_index) values
    ('${room}','user','distinct user one',1),('${room}','user','distinct user two',1),
    ('${room}','assistant','distinct reply one',1),('${room}','assistant','distinct reply two',1);`);
  const original=await query('select id,content,turn_index,is_active_variant from messages order by id');
  await db.exec(sql);
  assert.deepEqual(await query('select id,content,turn_index,is_active_variant from messages order by id'),original);
  assert.equal((await query('select count(*)::int n from messages where legacy_turn_conflict'))[0].n,4);
  await login(a);
  assert.equal((await query('select * from profiles')).length,1);
  assert.equal((await query('select * from public_profiles')).length,2);
  await db.query("update profiles set display_name='Changed public name',summary_prompt='private fixture' where id=$1",[a]);
  assert.equal((await query('select display_name from public_profiles where id=$1',[a]))[0].display_name,'Changed public name');
  await assert.rejects(()=>db.query("update public_profiles set display_name='forged' where id=$1",[a]));
  await db.query("insert into messages(session_id,role,content,turn_index) values($1,'user','new',2)",[room]);
  await assert.rejects(()=>db.query("insert into messages(session_id,role,content,turn_index) values($1,'user','duplicate',2)",[room]));
  await assert.rejects(()=>db.query('update messages set legacy_turn_conflict=true where session_id=$1 and turn_index=2',[room]));
  await login(null);
  assert.equal((await query('select * from profiles')).length,0);
  assert.equal((await query('select * from public_profiles')).length,2);
  await assert.rejects(()=>db.query('select claim_multichat_generation($1,true)',[room]));
  await assert.rejects(()=>db.query('select session_message_page($1)',[room]));
  await login(b);
  await assert.rejects(()=>db.query('select session_generation_context($1)',[room]));
  await assert.rejects(()=>db.query('select duplicate_work_atomic($1)',[work]));
  await login(a);
  const old=(await query("insert into messages(session_id,role,content,turn_index,reroll_index) values($1,'assistant','old',2,1) returning id",[room]))[0].id;
  const next=(await query("insert into messages(session_id,role,content,turn_index,reroll_index,reroll_group_id,is_active_variant,generation_status) values($1,'assistant','pending',2,2,$2,false,'streaming') returning id",[room,old]))[0].id;
  await db.exec('reset role');
  await db.exec(`create function fail_selection() returns trigger language plpgsql as $$begin if new.id='${next}' and new.is_active_variant then raise exception 'injected activation failure'; end if; return new; end$$;
    create trigger fail_selection before update on messages for each row execute function fail_selection();`);
  await login(a);
  await assert.rejects(()=>db.query('select select_session_variant($1,$2,$3,$2)',[room,old,next]));
  assert.equal((await query('select is_active_variant from messages where id=$1',[old]))[0].is_active_variant,true,'failed RPC rolls the first write back');
  await db.exec('reset role;drop trigger fail_selection on messages');
  await login(a);
  const finishArgs=[room,next,'complete response',11,22,0.125,null,null,old,old];
  await db.query('select finish_session_response($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',finishArgs);
  await db.query('select finish_session_response($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',finishArgs);
  assert.deepEqual((await query('select total_input_tokens,total_output_tokens,total_cost from sessions where id=$1',[room]))[0],{total_input_tokens:11,total_output_tokens:22,total_cost:'0.125'});
  assert.equal((await query('select generation_status from messages where id=$1',[next]))[0].generation_status,'complete');
  assert.equal((await query('select is_active_variant from messages where id=$1',[old]))[0].is_active_variant,false);
  await assert.rejects(()=>db.query('select select_session_variant($1,$2,$3,$4)',[room,old,old,old]),'stale selection cannot overwrite the winner');
  const failedFinal=(await query("insert into messages(session_id,role,content,turn_index,reroll_index,reroll_group_id,is_active_variant,generation_status) values($1,'assistant','preserved partial',2,3,$2,false,'streaming') returning id",[room,old]))[0].id;
  await db.exec('reset role');
  await db.exec(`create function fail_totals() returns trigger language plpgsql as $$begin if new.total_input_tokens>old.total_input_tokens then raise exception 'injected totals failure'; end if; return new; end$$;
    create trigger fail_totals before update on sessions for each row execute function fail_totals();`);
  await login(a);
  await assert.rejects(()=>db.query('select finish_session_response($1,$2,$3,2,3,0.02,null,null,$4,$5)',[room,failedFinal,'new final',old,next]));
  assert.deepEqual((await query('select content,generation_status,is_active_variant from messages where id=$1',[failedFinal]))[0],{content:'preserved partial',generation_status:'streaming',is_active_variant:false});
  assert.equal((await query('select is_active_variant from messages where id=$1',[next]))[0].is_active_variant,true);
  await db.exec('reset role;drop trigger fail_totals on sessions');
  await login(a);
  const sources=await query("select id,content_version as version from messages where session_id=$1 and role='user'",[room]);
  await db.query('select save_generated_summary($1,$2,2,$3,$4,0,3,4,0.01)',[room,'summary fixture',JSON.stringify(sources),'']);
  const saved=(await query('select * from summary_versions where session_id=$1',[room]))[0];
  await db.query('select mutate_session_summary($1,$2,$3,$4)',[room,'edit',saved.id,'edited fixture']);
  assert.equal((await query('select summary from sessions where id=$1',[room]))[0].summary,'edited fixture');
  await db.exec('reset role');
  await db.exec(`create function fail_summary_insert() returns trigger language plpgsql as $$begin if new.content='injected failure' then raise exception 'injected summary insert failure'; end if; return new; end$$;
    create trigger fail_summary_insert before insert on summary_versions for each row execute function fail_summary_insert();`);
  await login(a);
  await assert.rejects(()=>db.query('select save_generated_summary($1,$2,2,$3,$4,2,3,4,0.01)',[room,'injected failure',JSON.stringify(sources),'edited fixture']));
  assert.equal((await query('select is_active from summary_versions where id=$1',[saved.id]))[0].is_active,true,'failed insert must roll back deactivation');
  await db.exec('reset role;drop trigger fail_summary_insert on summary_versions');
  await login(a);
  const inactive=(await query("insert into summary_versions(session_id,content,summarized_through_turn,is_active) values($1,'inactive fixture',1,false) returning id",[room]))[0].id;
  await db.query('select mutate_session_summary($1,$2,$3,$4)',[room,'edit',inactive,'edited inactive']);
  assert.equal((await query('select summary from sessions where id=$1',[room]))[0].summary,'edited fixture');
  await db.query('select mutate_session_summary($1,$2,$3)',[room,'delete',inactive]);
  assert.equal((await query('select summary from sessions where id=$1',[room]))[0].summary,'edited fixture');
  await db.query('update messages set content=content||$1 where id=$2',[' changed',sources[0].id]);
  await assert.rejects(()=>db.query('select save_generated_summary($1,$2,2,$3,$4,2,3,4,0.01)',[room,'stale summary',JSON.stringify(sources),'edited fixture']));
  assert.equal((await query('select summary from sessions where id=$1',[room]))[0].summary,'edited fixture');
  await db.exec('reset role');
  await db.query(`insert into messages(session_id,role,content,turn_index,created_at)
    select $1,case when n%2=0 then 'assistant' else 'user' end,repeat('body ',600),((n+1)/2),'2026-01-01'::timestamptz
    from generate_series(1,1200)n`,[longRoom]);
  await login(a);
  let cursor=null,loaded=0,pages=0;
  do {
    const page=(await query('select session_message_page($1,$2) page',[longRoom,cursor]))[0].page;
    assert.equal(page.totalUserTurns,600);loaded+=page.messages.length;pages++;
    cursor=page.hasOlder?page.oldestTurn:null;
  }while(cursor!==null);
  assert.equal(loaded,1200);assert.equal(pages,120);
  await db.query("update sessions set summary='live memory',summary_last_turn=500 where id=$1",[longRoom]);
  const context=(await query('select session_generation_context($1,500,3,false) ctx',[longRoom]))[0].ctx.messages;
  assert.equal(context.length,1200);
  assert.equal(context.filter(m=>m.content).length,200);
  assert.equal(context.find(m=>m.turn_index===501&&m.role==='user').content.length,3000);
  assert.equal(context[0].content,'');
  const full=(await query('select session_generation_context($1,500,3,true) ctx',[longRoom]))[0].ctx.messages;
  assert.equal(full.filter(m=>m.content).length,1200);
  assert.ok(JSON.stringify(context).length<JSON.stringify(full).length*0.4);
  const start=(await query("insert into start_configs(work_id,name,initial_message,initial_context,is_default) values($1,'Start','First reply','Hidden context',true) returning id",[work]))[0].id;
  const sessionId=(await query('select create_session_with_start($1,null,$2) id',[work,start]))[0].id;
  assert.equal((await query('select count(*)::int n from messages where session_id=$1',[sessionId]))[0].n,2);
  const beforeCount=(await query('select count(*)::int n from works'))[0].n;
  await db.exec('reset role');
  await db.exec(`create function fail_child_copy() returns trigger language plpgsql as $$begin if new.work_id<>'${work}' then raise exception 'injected copy failure'; end if; return new; end$$;
    create trigger fail_child_copy before insert on start_configs for each row execute function fail_child_copy();`);
  await login(a);
  await assert.rejects(()=>db.query('select duplicate_work_atomic($1)',[work]));
  assert.equal((await query('select count(*)::int n from works'))[0].n,beforeCount);
  await db.exec('reset role;drop trigger fail_child_copy on start_configs');
  await login(a);
  const palette=JSON.stringify({accent:'#123456',accentText:'#ffffff',main:'#000000',mainText:'#ffffff'});
  const shared=(await query("insert into themes(owner_id,work_id,name,dark_colors,light_colors,ai_prompt,day_night_enabled,use_day_night_variants,work_shared) values($1,$2,'Shared',$3,$3,'Exact AI condition',true,false,true) returning id",[a,work,palette]))[0].id;
  await db.query("insert into themes(owner_id,work_id,name,dark_colors,work_shared) values($1,$2,'Private',$3,false)",[a,work,palette]);
  await db.query("update works set default_theme_id=$1,default_theme_variant='light' where id=$2",[shared,work]);
  const copy=(await query('select duplicate_work_atomic($1) id',[work]))[0].id;
  assert.equal((await query('select count(*)::int n from start_configs where work_id=$1',[copy]))[0].n,1);
  assert.equal((await query('select visibility from works where id=$1',[copy]))[0].visibility,'private');
  const copiedThemes=await query('select * from themes where work_id=$1',[copy]);
  assert.equal(copiedThemes.length,1,'personal themes remain private to their original work');
  assert.equal(copiedThemes[0].ai_prompt,'Exact AI condition');
  assert.equal(copiedThemes[0].day_night_enabled,true);
  assert.equal(copiedThemes[0].use_day_night_variants,false);
  assert.deepEqual(copiedThemes[0].dark_colors,JSON.parse(palette));
  assert.deepEqual(copiedThemes[0].light_colors,JSON.parse(palette));
  assert.equal((await query('select default_theme_id from works where id=$1',[copy]))[0].default_theme_id,copiedThemes[0].id);
  await db.exec('reset role');
  const preserved=await query('select id,content,turn_index from messages order by id');
  await db.exec(sql);
  assert.deepEqual(await query('select id,content,turn_index from messages order by id'),preserved);
  console.log('Integrity DB: real migrations, non-deleting conflicts, RLS/privacy, anonymous denial, atomic selection/response/summary/copy/start, idempotent cost, logical pagination and smaller generation context passed.');
} finally { await db.close(); }
