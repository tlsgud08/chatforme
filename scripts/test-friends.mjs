import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'vite';
const db = new PGlite(), dir = new URL('../supabase/migrations/', import.meta.url);
const a='00000000-0000-0000-0000-000000000001', b='00000000-0000-0000-0000-000000000002', c='00000000-0000-0000-0000-000000000003';
const work='10000000-0000-0000-0000-000000000001', secret='10000000-0000-0000-0000-000000000002';
const sa='20000000-0000-0000-0000-000000000001', sb='20000000-0000-0000-0000-000000000002', privateSession='20000000-0000-0000-0000-000000000003';
const ca='30000000-0000-0000-0000-000000000001', cb='30000000-0000-0000-0000-000000000002', cb2='30000000-0000-0000-0000-000000000003';
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
 assert.equal((await q("select to_regclass('public.user_follows') id"))[0].id,null,'unused follows are retired without turning them into friends');
 await db.exec(`insert into works(id,creator_id,title,visibility) values('${work}','${a}','Public work','public'),('${secret}','${b}','Secret work','private');
 insert into sessions(id,user_id,work_id,title) values('${sa}','${a}','${work}','A chat'),('${sb}','${b}','${work}','B chat'),('${privateSession}','${b}','${secret}','Private chat');`);
 await login(null);
 await assert.rejects(()=>q('select id from works'),/permission denied/);
 await assert.rejects(()=>rpc('get_friend_social_state'));
 assert.equal(await rpc('verify_signup_master_password',['fixture password']),true,'pre-login account registration still works');
 await login(a);assert.equal((await rpc('get_friend_social_state')).relationships.length,0);
 await assert.rejects(()=>rpc('change_friendship',[a,'request']));
 await rpc('change_friendship',[b,'request']);await rpc('change_friendship',[b,'request']);
 assert.equal((await rpc('get_friend_social_state')).relationships[0].status,'pending');
 await assert.rejects(()=>rpc('change_friendship',[b,'accept']),/받은 친구/);
 await login(c);assert.equal((await rpc('get_friend_social_state')).relationships.length,0);assert.equal((await q('select id from friendships')).length,0);
 await login(b);await rpc('change_friendship',[a,'reject']);assert.equal((await rpc('get_friend_social_state')).relationships.length,0);
 await login(a);await rpc('change_friendship',[b,'request']);await rpc('change_friendship',[b,'cancel']);assert.equal((await rpc('get_friend_social_state')).relationships.length,0);
 await rpc('change_friendship',[b,'request']);await login(b);await rpc('change_friendship',[a,'accept']);await rpc('change_friendship',[a,'accept']);
 assert.equal((await rpc('get_friend_social_state')).relationships[0].status,'accepted');
 assert.deepEqual(await q('update friendships set status=$1 returning id',['removed']),[],'direct updates cannot bypass the friendship state machine');
 assert.equal((await rpc('get_friend_social_state')).relationships[0].status,'accepted');
 await rpc('touch_friend_activity',[cb,sb,new Date().toISOString()]);
 await login(a);let state=await rpc('get_friend_social_state'), friend=state.relationships[0];
 assert.equal(friend.last_work_id,work);assert.equal(friend.connections[0].work_id,work);
 assert.equal(JSON.stringify(state).includes(sb),false,'private session IDs never enter friend data');
 assert.equal((await q('select * from friend_connections')).length,0,'raw peer connection data stays private');
 assert.equal((await q('select user_id from friend_activity_signals where user_id=$1',[b])).length,1);
 await assert.rejects(()=>rpc('touch_friend_activity',[ca,sb,new Date().toISOString()]),/채팅방/);
 await assert.rejects(()=>rpc('touch_friend_activity',[cb,sa,new Date().toISOString()]),/다른 접속/);
 await login(b);const older=new Date(Date.now()-10*60_000).toISOString();await rpc('touch_friend_activity',[cb2,privateSession,older]);
 await login(a);state=await rpc('get_friend_social_state');assert.equal(state.relationships[0].last_work_id,work,'old idle tab cannot overwrite a newer last-played work');
 assert.equal((await q('select id from works where id=$1',[secret])).length,0,'friendship does not unlock private works');
 await login(b);await rpc('set_friend_activity_sharing',[false]);
 await login(a);friend=(await rpc('get_friend_social_state')).relationships[0];assert.equal(friend.last_work_id,null);assert.equal(friend.connections.length,0);
 await login(b);await rpc('set_friend_activity_sharing',[true]);await rpc('stop_friend_activity',[cb]);await rpc('stop_friend_activity',[cb2]);
 await rpc('touch_friend_activity',[cb,sb,new Date().toISOString()]);
 const closedBeforeFirstHeartbeat='30000000-0000-0000-0000-000000000004';
 await rpc('stop_friend_activity',[closedBeforeFirstHeartbeat]);
 await rpc('touch_friend_activity',[closedBeforeFirstHeartbeat,sb,new Date().toISOString()]);
 await login(a);friend=(await rpc('get_friend_social_state')).relationships[0];assert.equal(friend.connections.length,0,'late heartbeat cannot resurrect a closed connection');assert.equal(friend.last_work_id,work,'offline retains last-played work');
 await login(c);assert.equal((await q('select user_id from friend_activity_signals')).length,0,'non-friends receive no activity signals');
 await login(a);await rpc('change_friendship',[b,'remove']);assert.equal((await rpc('get_friend_social_state')).relationships.length,0);
 assert.equal((await q('select user_id from friend_activity_signals where user_id=$1',[b])).length,0,'friend removal revokes activity access');
 await rpc('change_friendship',[b,'request']);await login(b);await rpc('change_friendship',[a,'request']);assert.equal((await rpc('get_friend_social_state')).relationships[0].status,'accepted','crossed requests produce one mutual friendship');
 console.log('Friends DB: mutual requests/accept/reject/cancel/remove, member-only data, private signals, validated session activity, multi-tab ordering, privacy, offline persistence, late-heartbeat protection and signup compatibility passed');
}finally{await db.close();}
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try{
 const {friendView,friendActivityLabel,FRIEND_AWAY_MS,FRIEND_CONNECTION_TTL_MS}=await server.ssrLoadModule('/src/lib/friends.ts');
 const now=Date.now(),iso=stamp=>new Date(stamp).toISOString();
 const base={user_id:b,display_name:'Friend',status:'accepted',requested_by:a,sharing_enabled:true,last_work_id:work,last_played_at:iso(now-60_000),connections:[{seen_at:iso(now),active_at:iso(now-FRIEND_AWAY_MS+1),work_id:work}]};
 assert.equal(friendView(base,now).presence,'online');
 const away=friendView({...base,connections:[{...base.connections[0],active_at:iso(now-FRIEND_AWAY_MS)}]},now);
 assert.equal(away.presence,'away');assert.equal(away.currentWorkId,work);assert.equal(friendActivityLabel(away,{[work]:{title:'빅토리아 3'}}),'빅토리아 3 플레이 중');
 const offline=friendView({...base,connections:[{...base.connections[0],seen_at:iso(now-FRIEND_CONNECTION_TTL_MS)}]},now);
 assert.equal(offline.presence,'offline');assert.equal(friendActivityLabel(offline,{[work]:{title:'빅토리아 3'}}),'마지막 플레이 · 빅토리아 3');
 assert.equal(friendView({...base,connections:[{seen_at:iso(now),active_at:iso(now-1000),work_id:null},{seen_at:iso(now),active_at:iso(now-5000),work_id:work}]},now).currentWorkId,null,'latest active browser wins');
 assert.equal(friendView({...base,connections:[{seen_at:iso(now-180_000),active_at:iso(now-180_000),work_id:secret},...base.connections]},now).presence,'online','one live device keeps the user online');
 assert.equal(friendView({...base,sharing_enabled:false},now).displayWorkId,null);
 assert.equal(friendActivityLabel(away,{}),'비공개 작품 플레이 중');
 console.log('Friends activity: exact 3-minute away boundary, retained playing state, offline last work, multiple devices/tabs and hidden/private metadata passed');
}finally{await server.close();}
