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
 const publicWork='10000000-0000-0000-0000-000000000002', otherRoom='20000000-0000-0000-0000-000000000002';
 await db.exec('reset role');
 await db.query("insert into works(id,creator_id,title,visibility,main_prompt) values($1,$2,'Public','public','')",[publicWork,a]);
 await db.query('update sessions set work_id=$1,total_cost=2 where id=$2',[publicWork,room]);
 await db.query('insert into sessions(id,user_id,work_id,total_cost,is_archived) values($1,$2,$3,3,true)',[otherRoom,b,publicWork]);
 await db.query("insert into messages(session_id,role,content,turn_index) select $1,'user','fixture',n from generate_series(0,1200)n",[room]);
 await db.query("insert into messages(session_id,role,content,turn_index,is_active_variant,is_hidden) values($1,'assistant','',1,true,false),($1,'assistant','',2,false,false),($1,'user','',1201,false,false),($1,'user','',1202,true,true),($2,'user','',1,true,false)",[room,otherRoom]);
 const stats=async(workId)=>(await query('select * from work_usage_totals($1)',[workId]))[0];
 await login(a);
 assert.deepEqual(await stats(publicWork),{turn_count:1202,total_cost_usd:'5'},'all users/archived rooms; costs summed once per room, not multiplied by message count');
 assert.equal((await query('select count(*)::int n from messages where session_id=$1',[otherRoom]))[0].n,0,'aggregate visibility never grants transcript access');
 const counts=await query('select * from session_conversation_counts($1)',[[room,room,otherRoom]]);
 assert.deepEqual(counts,[{session_id:room,conversation_count:1201}],'duplicates, foreign sessions, legacy turn zero, hidden and inactive filtering');
 assert.deepEqual(await stats(work),{turn_count:0,total_cost_usd:'0'},'empty accessible work has real zeros');
 await login(b);
 assert.deepEqual(await stats(publicWork),{turn_count:1202,total_cost_usd:'5'});
 await assert.rejects(stats(work),/inaccessible/);
 await assert.rejects(db.query('select * from private.work_usage_totals($1)',[work]),/inaccessible/);
 await assert.rejects(stats('10000000-0000-0000-0000-000000000099'),/inaccessible/);
 await login(null);await assert.rejects(stats(publicWork),/permission denied/);
 await db.exec('reset role');
 const before=await query('select * from messages order by id');
 const migration=readdirSync(dir).find(n=>n.endsWith('_work_usage_and_fast_turn_counts.sql'));
 await db.exec(readFileSync(new URL(migration,dir),'utf8'));
 assert.deepEqual(await query('select * from messages order by id'),before,'reapplication does not rewrite messages');
 console.log('Work usage: all-user aggregate, archived/empty/foreign/private/anon access, no transcript leak, >1000 turns, legacy zero, variants, cost join multiplication, duplicate IDs and additive migration passed');
} finally { await db.close(); }
