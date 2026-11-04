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
 const {randomUUID:uuid}=await import('node:crypto');
 const add=async(status,active,turn=1,group=null,age='0 minutes')=>{
   const id=uuid();
   await db.query(`insert into messages(id,session_id,role,content,turn_index,is_active_variant,generation_status,reroll_group_id,created_at,reroll_index)
    values($1,$2,'assistant','fixture',$3,$4,$5,$6,now()-$7::interval,(select coalesce(max(reroll_index),0)+1 from messages where session_id=$2 and turn_index=$3))`,[id,room,turn,active,status,group,age]);
   return id;
 };
 const ids=async()=> (await query('select id from messages where session_id=$1 order by id',[room])).map(x=>x.id);
 const hash=async()=> (await query('select session_response_context_hash($1) v',[room]))[0].v;
 const args=async(turn,reroll=null,variant=1,user=true)=>[room,uuid(),user?uuid():null,'next',null,null,null,[],'',0,reroll,turn,variant,await hash()];
 const begin=async(args)=>(await query('select begin_session_response('+args.map((_,i)=>'$'+(i+1)).join(',')+') v',args))[0].v;
 const selected=await add('complete',true);
 const completed=await add('complete',false,1,selected);
 const interrupted=await add('interrupted',false,1,selected);
 const abandoned=await add('streaming',false,1,selected,'20 minutes');
 await query('select recover_expired_session_responses($1)',[room]);
 const before=await ids();
 await login(b);await assert.rejects(begin(await args(2)),/inaccessible/);await login(a);
 assert.deepEqual(await ids(),before,'another account cannot trigger cleanup');
 await assert.rejects(begin([...(await args(2)).slice(0,-1),'stale']),/Dialogue changed/);
 assert.deepEqual(await ids(),before,'invalid source keeps all candidates');
 const reroll=await begin(await args(1,selected,5,false));
 assert((await ids()).includes(completed),'same-turn reroll retains comparison candidates');
 await assert.rejects(begin(await args(2)),/generating/);
 assert((await ids()).includes(interrupted),'live request blocks advancement and cleanup');
 await db.query("update messages set generation_status='interrupted' where id=$1",[reroll.draft.id]);
 // A failed draft insert must roll back both pruning and user insertion.
 await db.exec(`reset role;create function fail_prune_draft() returns trigger language plpgsql as $$begin
 if new.role='assistant' then raise exception 'injected draft failure';end if;return new;end$$;
 create trigger fail_prune_draft before insert on messages for each row execute function fail_prune_draft();`);
 await login(a);const beforeFailure=await ids();
 await assert.rejects(begin(await args(2)),/injected draft failure/);
 assert.deepEqual(await ids(),beforeFailure,'failed advance rolls back deletion');
 await db.exec('reset role;drop trigger fail_prune_draft on messages');await login(a);
 const advanceArgs=await args(2);const started=await begin(advanceArgs);
 const after=await ids();
 for(const id of [completed,interrupted,abandoned,reroll.draft.id])assert(!after.includes(id),'old inactive attempt deleted regardless of status');
 assert(after.includes(selected),'selected answer survives');
 assert.equal((await begin(advanceArgs)).replayed,true,'lost acknowledgement replay stays idempotent');
 const finished=(await query("select finish_session_response($1,$2,'answer',1,2,0.01,null,null) v",[room,started.draft.id]))[0].v;
 assert.equal(finished.contextConflict,false,'cleanup happens before the new context fingerprint');
 const rejected=await add('interrupted',false,2,started.draft.id);
 const continuation=await begin(await args(3,null,1,false));
 assert.equal(continuation.userMessage,null);
 assert(!(await ids()).includes(rejected),'continuation also closes the preceding turn');
 assert((await ids()).includes(started.draft.id),'active reply is preserved across continuation');
 await assert.rejects(db.query("select finish_session_response($1,$2,'late response',1,2,0.01,null,null) v",[room,rejected]),/inaccessible/);
 assert(!(await ids()).includes(rejected),'late commit cannot recreate a deleted candidate');
 console.log('Response pruning: completed/interrupted/abandoned, same-turn comparison, live generation guard, source conflict, rollback, replay, RLS, continuation and finish hash passed');
} finally { await db.close(); }
