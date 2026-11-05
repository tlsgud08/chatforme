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
 const publicWork='10000000-0000-0000-0000-000000000002',emptyWork='10000000-0000-0000-0000-000000000003';
 const otherRoom='20000000-0000-0000-0000-000000000002';
 await db.exec('reset role');
 await db.query("insert into works(id,creator_id,title,visibility,main_prompt) values($1,$3,'Public','public',''),($2,$3,'Empty','public','')",[publicWork,emptyWork,a]);
 await db.query('update sessions set work_id=$1,total_cost=2 where id=$2',[publicWork,room]);
 await db.query('insert into sessions(id,user_id,work_id,total_cost,is_archived) values($1,$2,$3,3,true)',[otherRoom,b,publicWork]);
 const rank=async(ids)=>query('select * from work_catalog_rankings($1) order by work_id',[ids]);
 await login(a);
 assert.deepEqual(await rank([publicWork,publicWork,emptyWork,work]),[
  {work_id:work,session_count:0,total_cost_usd:'0'},
  {work_id:publicWork,session_count:2,total_cost_usd:'5'},
  {work_id:emptyWork,session_count:0,total_cost_usd:'0'},
 ],'one row per accessible work; zero-play works and all users/archived sessions included');
 assert.equal((await query('select count(*)::int n from sessions where id=$1',[otherRoom]))[0].n,0,'aggregate does not expose other sessions');
 await login(b);
 assert.equal((await rank([publicWork,work])).length,1,'private work excluded');
 assert.equal((await query('select * from private.work_catalog_rankings($1)',[[work]])).length,0,'private helper checks access too');
 assert.deepEqual(await rank([]),[]);assert.deepEqual(await rank(null),[]);
 await login(null);await assert.rejects(rank([publicWork]),/permission denied/);
 console.log('Work ranking DB: all-user/archived totals, zero-play works, duplicate/null/empty IDs, private/anon and session privacy passed');
} finally { await db.close(); }
