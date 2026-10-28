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
 await db.exec(`insert into works(id,creator_id,title,visibility) values('${work}','${b}','Public work','public'),('${secret}','${b}','Secret work','private');
 insert into sessions(id,user_id,work_id,title) values('${sa}','${b}','${work}','First room'),('${sb}','${b}','${work}','Second room');`);
 const iso=s=>new Date(Date.UTC(2025,0,1)+s*1000).toISOString();
 const conn=n=>`30000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
 const runFor=async(id)=>(await q('select play_run_id from friend_connections where connection_id=$1',[id]))[0]?.play_run_id;
 // Deterministic server-time fixtures exercise the actual internal ledger.
 async function step(id,t,session=sa,active=t){
  await rpc('settle_friend_play',[id,iso(t)]);
  const run=session?await rpc('enter_friend_play',[b,session,work,iso(t)]):null;
  await q(`insert into friend_connections(connection_id,user_id,work_id,seen_at,active_at,play_run_id,activity_type) values($1,$2,$3,$4,$5,$6,$7)
   on conflict(connection_id) do update set seen_at=excluded.seen_at,active_at=excluded.active_at,play_run_id=excluded.play_run_id,activity_type=excluded.activity_type,work_id=excluded.work_id`,[id,b,session?work:null,iso(t),iso(active),run,session?'play':null]);
  return run;
 }
 const time=async(run,t)=>Number((await rpc('friend_play_time',[run,iso(t)])).duration_ms);
 let run=await step(conn(10),0);
 for(let t=30;t<=210;t+=30)assert.equal(await step(conn(10),t,sa,0),run);
 assert.equal(await time(run,300),180000,'3-minute idle boundary stops play time');
 assert.equal(await time(run,360),180000,'away never accrues additional time');
 assert.equal(await step(conn(10),360,sa,360),run,'ongoing away stays in same run');
 await step(conn(10),390);await step(conn(10),420,null);
 assert.equal(await time(run,500),240000,'active resume counts 60 seconds; room exit freezes');
 assert.equal(await step(conn(10),600),run,'return exactly 3 minutes after room exit resumes');
 assert.equal(await time(run,630),270000,'180-second gap is excluded');
 await step(conn(10),660,null);assert.equal(await time(run,700),300000);
 const fresh=await step(conn(10),841);assert.notEqual(fresh,run,'return after 3 minutes starts a new run');assert.equal(await time(fresh,841),0);
 assert.equal(await time(run,1000),300000,'completed run remains recorded');
 const second=await step(conn(11),850,sb);assert.notEqual(second,fresh,'same work in different rooms has independent runs');
 // Multiple devices contribute the union of intervals, never their sum.
 const multi=await step(conn(20),2000);
 assert.equal(await step(conn(21),2010),multi);
 await step(conn(20),2015);await step(conn(21),2060);
 assert.equal(await time(multi,2060),60000,'overlapping device intervals are counted once');
 await step(conn(21),2070,null);assert.equal(await time(multi,2080),80000,'leaving one device does not stop another live device');
 await step(conn(20),2090,null);assert.equal(await time(multi,2190),90000);
 const offline=await step(conn(30),2300);
 assert.equal(await time(offline,3000),120000,'unannounced disconnect is capped by the existing 2-minute connection lease');
 assert.equal(await time(offline,4000),120000);
 await rpc('settle_friend_play',[conn(30),iso(5000)]);await q('delete from friend_connections where connection_id=$1',[conn(30)]);
 assert.equal(await time(offline,6000),120000,'connection cleanup preserves the stopped duration');
 // Use the real validated RPCs under authenticated roles as well.
 await login(a);await rpc('change_friendship',[b,'request']);await login(b);await rpc('change_friendship',[a,'accept']);
 const visit='40000000-0000-0000-0000-000000000001', currentConnection=conn(40);
 await rpc('touch_friend_activity_state',[currentConnection,visit,sa,null,new Date().toISOString()]);
 const actualRun=await runFor(currentConnection);assert.ok(actualRun);
 await db.exec('reset role');await q("update friend_connections set seen_at=clock_timestamp()-interval '10 seconds' where connection_id=$1",[currentConnection]);await login(b);
 await rpc('touch_friend_activity_state',[currentConnection,visit,null,null,new Date().toISOString()]);
 await login(a);let social=await rpc('get_friend_social_state');let peer=social.relationships[0];
 assert.ok(peer.last_play_time.duration_ms>=10000&&peer.last_play_time.duration_ms<15000);
 assert.equal(peer.connections[0].last_play_time.running_until,null,'leaving the room pauses the displayed last-work timer');
 assert.equal(JSON.stringify(social).includes(sa),false,'private room IDs never enter the friend payload');
 assert.equal((await q('select id from friend_play_runs')).length,0,'peer play ledgers remain private');
 await assert.rejects(()=>rpc('enter_friend_play',[a,sa,work,new Date().toISOString()]));
 await login(b);await rpc('touch_friend_activity_state',[currentConnection,visit,sa,null,new Date().toISOString()]);assert.equal(await runFor(currentConnection),actualRun);
 await rpc('stop_friend_activity',[currentConnection]);await rpc('touch_friend_activity_state',[currentConnection,visit,sa,null,new Date().toISOString()]);
 assert.equal((await q('select closed from friend_connections where connection_id=$1',[currentConnection]))[0].closed,true);
 await rpc('touch_friend_activity_state',[conn(41),visit,sa,null,new Date().toISOString()]);assert.equal(await runFor(conn(41)),actualRun,'refresh/reconnect within grace resumes without a browser counter');
 await rpc('touch_friend_activity_state',[conn(41),visit,null,secret,new Date().toISOString()]);
 await login(a);peer=(await rpc('get_friend_social_state')).relationships[0];assert.equal(peer.last_activity_type,'create');assert.equal(peer.last_play_time,null);assert.equal(peer.connections[0].play_time,null,'creation does not accrue or display play time');
 await login(b);await rpc('set_friend_activity_sharing',[false]);await login(a);peer=(await rpc('get_friend_social_state')).relationships[0];assert.equal(peer.last_play_time,null);assert.deepEqual(peer.connections,[]);
 await login(null);await assert.rejects(()=>q('select * from friend_play_runs'));
 console.log('Play time DB: exact away stop/resume, leave pause, 3-minute return/reset, same-work room isolation, union of devices, offline cap, cleanup persistence, real RPCs, reconnect, creator exclusion and privacy passed');
}finally{await db.close();}
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try{
 const {friendView,friendActivityLabel,friendActivityDescription,friendPlayMilliseconds,formatFriendPlayTime}=await server.ssrLoadModule('/src/lib/friends.ts');
 const now=Date.now(),iso=t=>new Date(t).toISOString(), timer={duration_ms:1200000,measured_at:iso(now),running_until:iso(now+30000)};
 assert.equal(friendPlayMilliseconds(timer,now+15000),1215000);assert.equal(friendPlayMilliseconds(timer,now+60000),1230000);assert.equal(friendPlayMilliseconds({...timer,running_until:null},now+60000),1200000);
 for(const [ms,text] of [[0,'1분 미만'],[59999,'1분 미만'],[60000,'1분'],[3599999,'59분'],[3600000,'1시간'],[3660000,'1시간 1분']])assert.equal(formatFriendPlayTime(ms),text);
 const base={user_id:b,display_name:'friend',status:'accepted',sharing_enabled:true,last_work_id:work,last_activity_type:'play',last_play_time:{...timer,running_until:null},connections:[{seen_at:iso(now),active_at:iso(now),work_id:work,activity_type:'play',play_time:timer}]};
 const works={[work]:{title:'빅토리아 3'}};
 assert.equal(friendActivityLabel(friendView(base,now),works),'빅토리아 3 · 20분 플레이 중');
 const away={...base,connections:[{...base.connections[0],active_at:iso(now-180000),play_time:{...timer,running_until:iso(now)}}]};
 assert.equal(friendActivityLabel(friendView(away,now+30000),works),'자리 비움 · 빅토리아 3 · 20분 플레이');assert.equal(friendActivityDescription(friendView(away,now),works),'자리 비움 · 빅토리아 3 · 20분 플레이');
 assert.equal(friendView({...base,connections:[]},now+300000).displayPlayMs,1200000);
 assert.equal(friendActivityLabel(friendView({...base,connections:[]},now),works),'오프라인 · 마지막 플레이 · 빅토리아 3 · 20분 플레이');
 assert.equal(friendView({...base,sharing_enabled:false},now).displayPlayMs,null);
 console.log('Play time UI model: live clock, deadline freeze, minute/hour formatting, away/offline captions and hidden activity passed');
}finally{await server.close();}
