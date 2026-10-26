import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const dir=new URL('../supabase/migrations/',import.meta.url);
const a='00000000-0000-0000-0000-000000000001',b='00000000-0000-0000-0000-000000000002';
const work='10000000-0000-0000-0000-000000000001',room='20000000-0000-0000-0000-000000000001';
const query=async(sql,params=[]) => (await db.query(sql,params)).rows;
async function login(id){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);await db.exec(id?'set role authenticated':'set role anon');}
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
  for (const file of readdirSync(dir).filter(n=>n.startsWith('2026')).sort()) {
    try { await db.exec(readFileSync(new URL(file,dir),'utf8')); } catch(error) { throw new Error(file+': '+error.message); }
  }

 await db.exec(`grant usage on schema public,auth to anon,authenticated;
 grant select,insert,update,delete on all tables in schema public to anon,authenticated;
 insert into auth.users(id,email)values('${a}','a@example.test'),('${b}','b@example.test');
 insert into works(id,creator_id,title,visibility,main_prompt)values('${work}','${a}','Original','private','old main');
 insert into sessions(id,user_id,work_id)values('${room}','${a}','${work}');
 insert into start_configs(work_id,name,initial_message)values('${work}','Start','Welcome');
 insert into keyword_books(work_id,name,content)values('${work}','Keyword','Old');`);
 await login(a);
 const snapshot=async()=>(await query('select work_editor_snapshot($1) v',[work]))[0].v;
 const old=await snapshot();const next=structuredClone(old);next.work.main_prompt='new main';next.starts[0].initial_message='New start';next.keywords[0].content='New keyword';
 await db.exec('reset role');
 await db.exec(`create function fail_keyword_save()returns trigger language plpgsql as $$begin raise exception 'injected child failure';end$$;
 create trigger fail_keyword_save before update on keyword_books for each row execute function fail_keyword_save();`);
 await login(a);
 await assert.rejects(db.query('select save_work_editor($1,$2,$3)',[work,old,next]),/injected child failure/);
 assert.deepEqual(await snapshot(),old,'all earlier writes must roll back');
 await db.exec('reset role;drop trigger fail_keyword_save on keyword_books');await login(a);
 assert.equal((await query('select save_work_editor($1,$2,$3) v',[work,old,next]))[0].v,true);
 assert.deepEqual(await snapshot(),next);
 assert.equal((await query('select save_work_editor($1,$2,$3) v',[work,old,next]))[0].v,true,'lost acknowledgement replay');
 const changed=structuredClone(next);changed.work.title='Stale write';
 await assert.rejects(db.query('select save_work_editor($1,$2,$3)',[work,old,changed]),/Work changed/);
 await login(b);await assert.rejects(db.query('select save_work_editor($1,$2,$3)',[work,next,changed]),/inaccessible/);
 await login(null);await assert.rejects(db.query('select save_work_editor($1,$2,$3)',[work,next,changed]),/permission denied/);await login(a);
 // SELECT still succeeds after write rights disappear: 0 changed rows is failure.
 await db.exec('reset role;drop policy works_update_editors on works;create policy works_update_editors on works for update using(false) with check(false)');
 await login(a);
 const deniedChange=structuredClone(next);deniedChange.work.title='Not actually writable';
 await assert.rejects(db.query('select save_work_editor($1,$2,$3)',[work,next,deniedChange]),/inaccessible/);
 assert.deepEqual(await snapshot(),next);
 await db.exec('reset role;drop policy works_update_editors on works;create policy works_update_editors on works for update using(can_edit_work(id)) with check(can_edit_work(id))');
 await db.exec(`create function skip_work_write()returns trigger language plpgsql as $$begin return null;end$$;
 create trigger skip_work_write before update on works for each row execute function skip_work_write();`);
 await login(a);
 await assert.rejects(db.query('select save_work_editor($1,$2,$3)',[work,next,deniedChange]),/write denied/);
 assert.deepEqual(await snapshot(),next);
 await db.exec('reset role;drop trigger skip_work_write on works');await login(a);
 const sources=async()=>(await query(`select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',content_version,'active',is_active_variant)),'[]'::jsonb) v from messages where session_id=$1`,[room]))[0].v;
 const response='30000000-0000-0000-0000-000000000001',userMessage='40000000-0000-0000-0000-000000000001';
 const initialSources=await sources();
 const args=[room,response,userMessage,'Original question',null,null,null,initialSources,'',0,null,1,1];
 const begin=async values=>(await query('select begin_session_response('+values.map((_,i)=>'$'+(i+1)).join(',')+') v',values))[0].v;
 await db.exec('reset role');
 await db.exec(`create function fail_response_claim()returns trigger language plpgsql as $$begin if new.role='assistant' then raise exception 'injected response claim failure';end if;return new;end$$;
 create trigger fail_response_claim before insert on messages for each row execute function fail_response_claim();`);
 await login(a);await assert.rejects(begin(args),/injected response claim failure/);
 assert.equal((await query('select count(*)::int n from messages where session_id=$1',[room]))[0].n,0,'user row rolls back when draft creation fails');
 await db.exec('reset role;drop trigger fail_response_claim on messages');await login(a);
 const started=await begin(args);assert.equal(started.draft.id,response);assert.equal(started.userMessage.id,userMessage);
 assert.equal((await begin(args)).replayed,true);
 assert.equal((await query('select count(*)::int n from messages where session_id=$1',[room]))[0].n,2);
 await assert.rejects(begin(args.map((v,i)=>i===1?'30000000-0000-0000-0000-000000000002':v)),/generating/);
 await assert.rejects(db.query("select mutate_session_message($1,$2,'edit',0,null,null,'edited')",[room,userMessage]),/another screen/);
 // Simulate an older client that still has direct write permission.
 await db.query("update messages set content='Edited in an old tab' where id=$1",[userMessage]);
 const finish=async()=>(await query("select finish_session_response($1,$2,'Answer to original question',5,6,0.02,null,null) v",[room,response]))[0].v;
 const conflict=await finish();assert.equal(conflict.contextConflict,true);assert.equal(conflict.message.generation_status,'interrupted');assert.equal(conflict.message.is_active_variant,false);assert.equal(conflict.message.content,'Answer to original question');
 await finish();assert.equal((await query('select total_cost from sessions where id=$1',[room]))[0].total_cost,'0.02','no double accounting');
 const response2='30000000-0000-0000-0000-000000000002',user2='40000000-0000-0000-0000-000000000002';
 const hash=(await query('select session_generation_context($1) v',[room]))[0].v.contextHash;
 assert.equal(typeof hash,'string');
 const staleHash=[room,response2,user2,'New question',null,null,null,[],'',0,null,2,1,'stale hash'];
 await assert.rejects(begin(staleHash),/Dialogue changed/);
 const args2=[room,response2,user2,'New question',null,null,null,[],'',0,null,2,1,hash];await begin(args2);
 const complete=(await query("select finish_session_response($1,$2,'New answer',1,2,0.01,null,null) v",[room,response2]))[0].v;
 assert.equal(complete.contextConflict,false);assert.equal(complete.message.generation_status,'complete');
 const reroll='30000000-0000-0000-0000-000000000003';
 const rr=await begin([room,reroll,null,'',null,null,null,await sources(),'',0,response2,2,2]);
 assert.equal(rr.draft.is_active_variant,false);
 const interrupted=(await query("select interrupt_session_response($1,$2,'Partial reroll',$3,$3) v",[room,reroll,response2]))[0].v;
 assert.equal(interrupted.message.generation_status,'interrupted');assert.equal(interrupted.message.is_active_variant,true);
 assert.equal((await query('select is_active_variant from messages where id=$1',[response2]))[0].is_active_variant,false);
 await query("select interrupt_session_response($1,$2,'Partial reroll',$3,$3)",[room,reroll,response2]);
 assert.equal((await query('select total_cost from sessions where id=$1',[room]))[0].total_cost,'0.03','interrupt does not invent usage');
 await assert.rejects(db.query("select interrupt_session_response($1,$2,'different content',$3,$3)",[room,reroll,response2]),/changed/);
 await db.query("insert into messages(session_id,role,content,turn_index,generation_status,created_at)values($1,'assistant','KEEP PARTIAL',3,'streaming',now()-interval '16 minutes')",[room]);
 assert.equal((await query('select recover_expired_session_responses($1) n',[room]))[0].n,1);
 assert.equal((await query("select generation_status from messages where content='KEEP PARTIAL'"))[0].generation_status,'interrupted');
 assert.equal((await query('select recover_expired_session_responses($1) n',[room]))[0].n,0);
 await db.query("insert into messages(session_id,role,content,turn_index,generation_status)values($1,'assistant','LIVE',4,'streaming')",[room]);
 assert.equal((await query('select recover_expired_session_responses($1) n',[room]))[0].n,0,'live attempt cannot be expired');
 await login(b);await assert.rejects(db.query('select recover_expired_session_responses($1)',[room]),/inaccessible/);
 await login(null);await assert.rejects(db.query('select recover_expired_session_responses($1)',[room]),/permission denied/);
 await login(a);
 const config={system_prompt:'',theme_prompt:'',multichat_system_prompt:''};
 await assert.rejects(db.query('select save_platform_prompts($1,$2)',[config,config]),/Administrator/);
 await db.exec('reset role');
 await db.exec("create or replace function auth.email() returns text language sql stable as $$select current_setting('request.jwt.claim.email',true)$$;");
 await db.query("select set_config('request.jwt.claim.email','topshjtv@gmail.com',false)");await login(a);
 const configBefore=(await query("select jsonb_build_object('system_prompt',system_prompt,'theme_prompt',theme_prompt,'multichat_system_prompt',multichat_system_prompt) v from platform_config where id=1"))[0].v;
 const configAfter={...configBefore,system_prompt:'Long prompt '.repeat(4000)};
 assert.equal((await query('select save_platform_prompts($1,$2) v',[configBefore,configAfter]))[0].v,true);
 assert.equal((await query('select save_platform_prompts($1,$2) v',[configBefore,configAfter]))[0].v,true);
 await assert.rejects(db.query('select save_platform_prompts($1,$2)',[configBefore,{...configAfter,system_prompt:'STALE'}]),/Configuration changed/);
 await db.query("select set_config('request.jwt.claim.email','',false)");
 await db.exec('reset role');
 // Compare every returned field/hash with the pre-change context function,
 // including hidden/legacy turns, inactive variants and live server summaries.
 const contextSql=readFileSync(new URL('20261026002443_generation_context_single_pass.sql',dir),'utf8');
 const reference=readFileSync(new URL('20261025051847_chat_and_editor_recovery.sql',dir),'utf8')
   .match(/create or replace function public\.session_generation_context\([\s\S]*?end \$\$;/)[0]
   .replace('public.session_generation_context(', 'public.session_generation_context_reference(');
 await db.exec(reference);
 const contextRoom='20000000-0000-0000-0000-000000000005';
 await db.query('insert into sessions(id,user_id,work_id)values($1,$2,$3)',[contextRoom,a,work]);
 await db.query(`insert into messages(session_id,role,content,turn_index,created_at)
   select $1,case when n%2=0 then 'assistant' else 'user' end,'body '||n,(n+1)*2,'2026-01-01'::timestamptz from generate_series(1,40)n`,[contextRoom]);
 await db.query(`insert into messages(session_id,role,content,turn_index,is_hidden,reroll_index,is_active_variant)
   values($1,'user','legacy zero',0,false,1,true),($1,'user','hidden context',0,true,1,true),($1,'assistant','inactive variant',6,false,2,false)`,[contextRoom]);
 await login(a);
 let equivalent=0;
 for(const cutoff of [0,1,5,20,99])for(const keywords of [0,1,3,50])for(const reroll of [false,true]){
   await db.query("update sessions set summary='latest memory',summary_last_turn=$2 where id=$1",[contextRoom,cutoff]);
   const expected=(await query('select session_generation_context_reference($1,0,$2,$3) v',[contextRoom,keywords,reroll]))[0].v;
   const actual=(await query('select session_generation_context($1,0,$2,$3) v',[contextRoom,keywords,reroll]))[0].v;
   assert.deepEqual(actual,expected,'context rows/order/omitted bodies/commands/versions/hash must stay identical');equivalent++;
 }
 assert.equal(equivalent,40);
 await login(b);await assert.rejects(db.query('select session_generation_context($1)',[contextRoom]),/inaccessible/);
 await login(null);await assert.rejects(db.query('select session_generation_context($1)',[contextRoom]),/permission denied/);
 await db.exec('reset role');
 const before=await query('select * from messages order by id');
 await db.exec(readFileSync(new URL('20261025051847_chat_and_editor_recovery.sql',dir),'utf8'));
 await db.exec(contextSql);
 assert.deepEqual(await query('select * from messages order by id'),before,'reapply never changes data');
 console.log('Recovery DB: work transaction rollback/replay/conflict/RLS, atomic start/replay, concurrent generation guard, old-client source conflicts, idempotent costs, expired-only recovery and additive reapply passed');
 console.log('Single-pass context: 40 complete JSON/hash equivalence cases, logical gaps/legacy/hidden/variants/summary/keywords/reroll, owner/foreign/anon and reapply passed');
} finally { await db.close(); }
