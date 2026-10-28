import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'vite';
const db = new PGlite(), dir = new URL('../supabase/migrations/', import.meta.url);
const a='00000000-0000-0000-0000-000000000001', b='00000000-0000-0000-0000-000000000002', c='00000000-0000-0000-0000-000000000003';
const work='10000000-0000-0000-0000-000000000001', secret='10000000-0000-0000-0000-000000000002';
const sa='20000000-0000-0000-0000-000000000001', sb='20000000-0000-0000-0000-000000000002', privateSession='20000000-0000-0000-0000-000000000003';
const ca='30000000-0000-0000-0000-000000000001', cb='30000000-0000-0000-0000-000000000002', cb2='30000000-0000-0000-0000-000000000003';
const transitions=[], creationTransitions=[];
const q=async(sql,args=[])=>(await db.query(sql,args)).rows;
async function login(id){await db.exec('reset role');await q("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);await db.exec(id?'set role authenticated':'set role anon');}
async function rpc(name,args=[]){return (await q(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args))[0]?.value;}
try{
 await db.exec(`create role authenticated;create role anon;create role service_role;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.email() returns text language sql stable as $$select 'fixture@example.test'::text$$;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
 grant usage on schema public,auth to authenticated,anon;
 alter default privileges in schema public grant select,insert,update,delete on tables to authenticated,anon;
 create function public.verify_signup_master_password(candidate text) returns boolean language sql as $$select candidate='fixture password'$$;
 revoke all on function public.verify_signup_master_password(text) from public;
 grant execute on function public.verify_signup_master_password(text) to authenticated,anon;`);
 for(const file of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort()){
  if(file.startsWith('0012_')||file.startsWith('0032_'))continue;
  let source=readFileSync(new URL(file,dir),'utf8');
  if(file.startsWith('0003_follows')||file.startsWith('0008_'))source=source.split('insert into storage.buckets')[0];
  source=source.replace(/create extension if not exists pgcrypto;/gi,'').replace(/do \$\$ begin alter publication[\s\S]*?end \$\$;/gi,'');
  if(file.endsWith('_friends_and_activity.sql'))await db.exec(`insert into auth.users(id,email) values('${a}','a@test'),('${b}','b@test'),('${c}','c@test');insert into user_follows(follower_id,following_id) values('${a}','${b}');`);
  try{await db.exec(source);}catch(error){throw new Error(file+': '+error.message);}
 }
 await db.exec(`insert into works(id,creator_id,title,visibility) values('${work}','${b}','Editor work','public'),('${secret}','${b}','Other work','private');insert into sessions(id,user_id,work_id,title) values('${sa}','${b}','${work}','Chat');`);
 const iso=s=>new Date(Date.UTC(2025,0,1)+s*1000).toISOString(),id=n=>`30000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
 const time=async(run,t)=>Number((await rpc('friend_play_time',[run,iso(t)])).duration_ms);
 async function step(conn,t,wid=work,active=t){
  await rpc('settle_friend_play',[conn,iso(t)]);
  const run=wid?await rpc('enter_friend_creation',[b,wid,iso(t)]):null;
  await q(`insert into friend_connections(connection_id,user_id,work_id,seen_at,active_at,activity_type,play_run_id) values($1,$2,$3,$4,$5,$6,$7)
   on conflict(connection_id) do update set work_id=excluded.work_id,seen_at=excluded.seen_at,active_at=excluded.active_at,activity_type=excluded.activity_type,play_run_id=excluded.play_run_id`,[conn,b,wid,iso(t),iso(active),wid?'create':null,run]);return run;
 }
 const run=await step(id(10),0);
 for(let t=30;t<=600;t+=30)assert.equal(await step(id(10),t,work,0),run,'editor remains in same run throughout away heartbeats');
 assert.equal(await time(run,600),180000,'creation stops at exactly 3 minutes idle');
 await step(id(10),630);await step(id(10),660,null);assert.equal(await time(run,700),210000);
 assert.equal(await step(id(10),840),run,'editor return at 3 minutes resumes without the gap');
 await step(id(10),870,null);assert.equal(await time(run,900),240000);
 const fresh=await step(id(10),1051);assert.notEqual(fresh,run,'more than 3 minutes resets continuous creation');
 const other=await step(id(11),1060,secret);assert.notEqual(other,fresh,'different works keep independent timers');
 const multi=await step(id(20),2000);assert.equal(await step(id(21),2010),multi);
 await step(id(20),2020);await step(id(21),2060);assert.equal(await time(multi,2060),60000,'editor tabs do not double-count');
 await step(id(20),2070,null);await step(id(21),2070,null);assert.equal(await time(multi,2200),70000);
 const offline=await step(id(30),2500);assert.equal(await time(offline,3000),120000);assert.equal(await time(offline,4000),120000);
 await rpc('settle_friend_play',[id(30),iso(4000)]);await q('delete from friend_connections where connection_id=$1',[id(30)]);assert.equal(await time(offline,5000),120000);
 await login(a);await rpc('change_friendship',[b,'request']);await login(b);await rpc('change_friendship',[a,'accept']);
 const visit='40000000-0000-0000-0000-000000000001';
 await rpc('touch_friend_activity_state',[id(40),visit,null,work,new Date().toISOString()]);
 const actualRun=(await q('select play_run_id from friend_connections where connection_id=$1',[id(40)]))[0].play_run_id;
 await db.exec('reset role');await q("update friend_connections set seen_at=clock_timestamp()-interval '10 seconds' where connection_id=$1",[id(40)]);await login(b);
 await rpc('touch_friend_activity_state',[id(40),visit,null,null,new Date().toISOString()]);await login(a);
 let peer=(await rpc('get_friend_social_state')).relationships[0];assert.equal(peer.last_activity_type,'create');assert.ok(peer.last_activity_time.duration_ms>=10000);assert.equal(peer.last_activity_time.running_until,null);assert.equal(peer.last_play_time,null,'legacy play-only fields remain play-only');
 assert.equal((await q('select id from friend_play_runs')).length,0);await assert.rejects(()=>rpc('enter_friend_creation',[a,work,new Date().toISOString()]));
 await login(b);await rpc('touch_friend_activity_state',[id(40),visit,null,work,new Date().toISOString()]);assert.equal((await q('select play_run_id from friend_connections where connection_id=$1',[id(40)]))[0].play_run_id,actualRun);
 await rpc('touch_friend_activity_state',[id(40),visit,sa,null,new Date().toISOString()]);
 const playRun=(await q('select play_run_id from friend_connections where connection_id=$1',[id(40)]))[0].play_run_id;assert.notEqual(playRun,actualRun,'play and creation never mix even on the same work');
 await rpc('touch_friend_activity_state',[id(40),visit,null,work,new Date().toISOString()]);await rpc('stop_friend_activity',[id(40)]);
 await rpc('touch_friend_activity_state',[id(40),visit,null,work,new Date().toISOString()]);assert.equal((await q('select closed from friend_connections where connection_id=$1',[id(40)]))[0].closed,true);
 await db.exec('reset role');await q('insert into work_editors(work_id,user_id,granted_by) values($1,$2,$3)',[work,a,b]);await login(a);
 await rpc('touch_friend_activity_state',[id(41),'40000000-0000-0000-0000-000000000002',null,work,new Date().toISOString()]);
 await db.exec('reset role');await q('delete from work_editors where work_id=$1 and user_id=$2',[work,a]);await login(a);
 await assert.rejects(()=>rpc('touch_friend_activity_state',[id(41),'40000000-0000-0000-0000-000000000002',null,work,new Date().toISOString()]),/권한/);
 await login(b);await rpc('set_friend_activity_sharing',[false]);await login(a);peer=(await rpc('get_friend_social_state')).relationships[0];assert.equal(peer.last_activity_time,null);assert.deepEqual(peer.connections,[]);
 console.log('Creation time DB: exact away pause, long-idle resume, editor leave, 3-minute boundary/reset, work separation, tab union, offline/cleanup persistence, real RPCs, play/create separation, coeditor/revoked permissions and private sharing passed');
}finally{await db.close();}
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try{
 const {friendView,friendActivityLabel,friendActivityDescription}=await server.ssrLoadModule('/src/lib/friends.ts');
 const now=Date.now(),stamp=new Date(now).toISOString(),timer={duration_ms:1500000,measured_at:stamp,running_until:null};
 const base={sharing_enabled:true,last_work_id:work,last_activity_type:'create',last_activity_time:timer,connections:[{seen_at:stamp,active_at:stamp,work_id:work,activity_type:'create',activity_time:timer}]},works={[work]:{title:'빅토리아 3'}};
 assert.equal(friendActivityLabel(friendView(base,now),works),'빅토리아 3 · 25분 제작 중');
 const away={...base,connections:[{...base.connections[0],active_at:new Date(now-180000).toISOString()}]};assert.equal(friendActivityDescription(friendView(away,now),works),'자리 비움 · 빅토리아 3 · 25분 제작');
 assert.equal(friendActivityLabel(friendView({...base,connections:[]},now),works),'오프라인 · 마지막 제작 · 빅토리아 3 · 25분 제작');assert.equal(friendView({...base,sharing_enabled:false},now).displayActivityMs,null);assert.equal(friendView(base,now).displayPlayMs,null);
 console.log('Creation time UI: current/away/offline duration and private activity; play-only compatibility preserved');
}finally{await server.close();}
