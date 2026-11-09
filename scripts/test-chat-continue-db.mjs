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
 const user1='40000000-0000-0000-0000-000000000001', user20='40000000-0000-0000-0000-000000000020';
 const response='30000000-0000-0000-0000-000000000020';
 const continuation='40000000-0000-0000-0000-000000000021', nextResponse='30000000-0000-0000-0000-000000000021';
 await db.query("insert into messages(id,session_id,role,content,turn_index) values($1,$3,'user','first',0),($2,$3,'user','pending command',20)",[user1,user20,room]);
 await db.query("update messages set command_name='전개',command_prompt='original prompt' where id=$1",[user20]);
 await db.query("insert into messages(session_id,role,content,turn_index,is_hidden,is_active_variant) values($1,'assistant','first answer',0,false,true),($1,'assistant','hidden setup',100,true,true),($1,'assistant','discarded',20,false,false)",[room]);
 const sources=async()=>(await query("select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',content_version,'active',is_active_variant)),'[]'::jsonb) v from messages where session_id=$1",[room]))[0].v;
 const context=async()=>(await query('select session_generation_context($1) v',[room]))[0].v;
 const counts=async() => {
   const roomCount=(await query('select * from session_conversation_counts($1)',[[room]]))[0];
   const detail=(await query('select * from work_usage_totals($1)',[work]))[0];
   const catalog=(await query('select * from work_catalog_counts($1)',[[work]]))[0];
   const stats=(await query('select * from work_catalog_stats($1,true)',[[work]]))[0];
   assert.equal(Number(catalog.session_count),1); assert.equal(Number(stats.session_count),1);
   return [roomCount.conversation_count,detail.turn_count,catalog.message_count,stats.message_count].map(Number);
 };
 const assertCounts=async(n)=>assert.deepEqual(await counts(),[n,n,n,n], 'room count, work detail and both catalog counts must agree');
 await assertCounts(2);
 const originalUser=(await query('select * from messages where id=$1',[user20]))[0];
 const resumeArgs=[room,response,user20,await sources(),'',0,20,(await context()).contextHash];
 const resume=async(args)=>(await query('select resume_session_response('+args.map((_,i)=>'$'+(i+1)).join(',')+') v',args))[0].v;
 await assert.rejects(resume(resumeArgs.map((v,i)=>i===7?'stale':v)),/Dialogue changed/);
 await assert.rejects(resume(resumeArgs.map((v,i)=>i===6?21:v)),/User turn changed/);
 await assertCounts(2);
 // A failed claim is atomic and cannot alter the original user or any count.
 await db.exec(`reset role;create function fail_resume_claim() returns trigger language plpgsql as $$begin if new.id='${response}' then raise exception 'injected claim failure';end if;return new;end$$;
 create trigger fail_resume_claim before insert on messages for each row execute function fail_resume_claim();`);
 await login(a); await assert.rejects(resume(resumeArgs),/injected claim failure/); await assertCounts(2);
 await db.exec('reset role;drop trigger fail_resume_claim on messages'); await login(a);
 const started=await resume(resumeArgs);
 assert.equal(started.userMessage,null); assert.equal(started.draft.turn_index,20);
 assert.equal(started.draft.reroll_index,2,'an inactive failed attempt cannot collide with the resumed response');
 assert.equal((await resume(resumeArgs)).replayed,true,'lost acknowledgement is idempotent');
 assert.deepEqual((await query('select * from messages where id=$1',[user20]))[0],originalUser);
 await assertCounts(2);
 await assert.rejects(resume(resumeArgs.map((v,i)=>i===1?nextResponse:v)),/generating/);
 const finish=async(id)=>(await query("select finish_session_response($1,$2,'answer',10,20,0.02,null,null) v",[room,id]))[0].v;
 const finished=await finish(response);assert.equal(finished.contextConflict,false);assert.equal(finished.message.turn_index,20);
 await finish(response);await assertCounts(2);
 assert.equal((await query('select total_cost from sessions where id=$1',[room]))[0].total_cost,'0.02');
 const answeredHash=(await context()).contextHash;
 await assert.rejects(resume(resumeArgs.map((v,i)=>i===1?nextResponse:i===7?answeredHash:v)),/User turn changed/);

 // The AI-last Continue is an ordinary visible editable user message: exactly +1.
 const beginArgs=[room,nextResponse,continuation,'*이어서 계속 진행*',null,null,null,await sources(),'',0,null,21,1,(await context()).contextHash];
 const begin=async(args)=>(await query('select begin_session_response('+args.map((_,i)=>'$'+(i+1)).join(',')+') v',args))[0].v;
 const next=await begin(beginArgs); assert.equal(next.userMessage.content,'*이어서 계속 진행*');assert.equal(next.userMessage.is_hidden,false);assert.equal(next.draft.turn_index,21);
 await begin(beginArgs);await assertCounts(3);
 await finish(nextResponse);await assertCounts(3);
 let row=(await query('select * from messages where id=$1',[continuation]))[0];
 await query("select mutate_session_message($1,$2,'edit',$3,null,null,'사용자가 고친 이어가기')",[room,continuation,row.content_version]);
 await assertCounts(3);
 row=(await query('select * from messages where id=$1',[continuation]))[0];
 await query("select mutate_session_message($1,$2,'delete',$3,null,null,null)",[room,continuation,row.content_version]);
 await assertCounts(2);
 await login(b);await assert.rejects(resume(resumeArgs),/inaccessible/);
 await login(null);await assert.rejects(resume(resumeArgs),/permission denied/);
 await login(a);
 const before=await query('select * from messages order by id');
 const migration=readdirSync(dir).find(name=>name.endsWith('_resume_user_response.sql'));
 await db.exec('reset role');
 await db.exec(readFileSync(new URL(migration,dir),'utf8'));
 await login(a);
 assert.deepEqual(await query('select * from messages order by id'),before,'migration reapplication never rewrites or renumbers existing turns');
 await assertCounts(2);
 console.log('Continue DB: same-turn user reuse, unchanged room/detail/catalog counts, legacy zero/gaps/hidden/inactive, atomic rollback, stale/parallel guards, replay, cost idempotence, ordinary +1 continuation, edit/delete, RLS and additive migration passed.');
} finally {await db.close();}
