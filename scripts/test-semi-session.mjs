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
  if(file.endsWith('_global_summary_prompt.sql'))await db.exec(`update auth.users set email='topshjtv@gmail.com' where id='${a}';update profiles set summary_prompt=case when id='${a}' then E'ADMIN EXACT\\nSUMMARY' else 'PRIVATE USER' end;`);
  try{await db.exec(source);}catch(error){throw new Error(file+': '+error.message);}
 }

 await db.exec(`create or replace function auth.email() returns text language sql stable as $$select current_setting('test.email',true)$$;`);
 await login(a);await q("select set_config('test.email','topshjtv@gmail.com',false)");
 const original=(await q('select semi_multichat_prompt from platform_config where id=1'))[0].semi_multichat_prompt;
 assert.equal(await rpc('save_semi_multichat_prompt',[original,'SEMI RULES']),true);
 assert.equal(await rpc('save_semi_multichat_prompt',[original,'SEMI RULES']),true);
 await assert.rejects(()=>rpc('save_semi_multichat_prompt',[original,'STALE']));
 await q("insert into works(id,creator_id,title,visibility) values($1,$2,'World','public')",[work,a]);
 await db.exec('reset role');
 await q("insert into sessions(id,user_id,work_id,title,summary,summary_last_turn) values($1,$2,$3,'A','LOCAL A',1),($4,$5,$3,'B','LOCAL B',1),($6,$2,$3,'OTHER A','PRIVATE',0)",[sa,a,work,sb,b,privateSession]);
 const pa=(await q("insert into personas(user_id,name,description) values($1,'엘리','JOURNALIST') returning id",[a]))[0].id;
 await q('update sessions set persona_id=$1 where id=$2',[pa,sa]);
 await q("insert into messages(session_id,role,content,turn_index,is_summarized) values($1,'user','ACTION',1,true),($1,'assistant','STORY',1,true)",[sa]);
 await login(a);
 await assert.rejects(()=>rpc('semi_session_action',['request',sa,null,c,{}]),/친구/);
 await rpc('change_friendship',[b,'request']);await login(b);await rpc('change_friendship',[a,'accept']);await login(a);
 const invoke=(op,session,link=null,details={},other=null)=>rpc('semi_session_action',[op,session,link,other,details]);
 const link=await invoke('request',sa,null,{},b);assert.equal(link.status,'pending');
 await assert.rejects(()=>invoke('request',sa,null,{},b),/이미/);
 await login(c);assert.equal((await q('select id from semi_session_links')).length,0);await assert.rejects(()=>invoke('accept',sb,link.id));
 await login(b);await q("select set_config('test.email','b@test',false)");
 await assert.rejects(()=>rpc('save_semi_multichat_prompt',['SEMI RULES','USER RULES']),/운영자/);
 assert.deepEqual(await q("update platform_config set semi_multichat_prompt='DIRECT' where id=1 returning id"),[]);
 assert.equal((await q('select id from sessions where id=$1',[sa])).length,0,'link never grants source-session access');
 assert.equal((await invoke('accept',sb,link.id)).status,'active');
 await login(a);
 const beforeSession=(await q('select summary,summary_last_turn from sessions where id=$1',[sa]))[0];
 const beforeMessages=await q('select id,content,is_summarized from messages where session_id=$1 order by id',[sa]);
 const beforeVersions=await q('select * from summary_versions where session_id=$1',[sa]);
 const ticket=await invoke('prepare',sa,link.id);
 assert.equal(ticket.session.summary,'LOCAL A');
 await assert.rejects(()=>invoke('prepare',sa,link.id),/이미/);
 await assert.rejects(()=>invoke('publish',sa,link.id,{token:'wrong',content:'X'}),/변경/);
 const publish={token:ticket.token,content:'EXPORTED A',through_turn:1,input_tokens:10,output_tokens:20,cost:0.01};
 await invoke('publish',sa,link.id,publish);
 await invoke('publish',sa,link.id,publish);
 assert.deepEqual((await q('select summary,summary_last_turn from sessions where id=$1',[sa]))[0],beforeSession);
 assert.deepEqual(await q('select id,content,is_summarized from messages where session_id=$1 order by id',[sa]),beforeMessages);
 assert.deepEqual(await q('select * from summary_versions where session_id=$1',[sa]),beforeVersions);
 assert.equal(Number((await q('select total_cost from sessions where id=$1',[sa]))[0].total_cost),0.01,'lost acknowledgement does not double-account');
 await login(b);let saved=(await q('select * from semi_session_links where id=$1',[link.id]))[0];
 assert.equal(saved.snapshot_a.content,'EXPORTED A');assert.equal(saved.snapshot_a.persona.name,'엘리');
 assert.equal(saved.snapshot_b,null);assert.equal((await q('select summary from sessions where id=$1',[sb]))[0].summary,'LOCAL B');
 const bt=await invoke('prepare',sb,link.id);await invoke('publish',sb,link.id,{token:bt.token,content:'EXPORTED B',through_turn:1});
 await login(a);const edited=await invoke('prepare',sa,link.id);
 await q("update messages set content='EDITED' where session_id=$1 and role='user'",[sa]);
 await assert.rejects(()=>invoke('publish',sa,link.id,{token:edited.token,content:'STALE'}),/변경/);
 await invoke('release',sa,link.id,{token:edited.token});
 const closing=await invoke('prepare',sa,link.id);
 await login(b);await invoke('close',sb,link.id);
 await login(a);await assert.rejects(()=>invoke('publish',sa,link.id,{token:closing.token,content:'AFTER UNLINK'}),/활성/);
 assert.equal((await q('select snapshot_a from semi_session_links where id=$1',[link.id]))[0].snapshot_a,null);
 const reconnected=await invoke('request',sa,null,{},b);
 await login(b);await invoke('accept',sb,reconnected.id);
 await login(a);await rpc('change_friendship',[b,'remove']);
 assert.equal((await q("select count(*)::int n from semi_session_links where status<>'closed'"))[0].n,0,'unfriend releases reservations');
 await login(null);await assert.rejects(()=>invoke('request',sa,null,{},b));
 console.log('Semi session DB: opt-in links, owner/friend checks, isolated export, PC2 snapshot, paid-call replay, concurrent generation lease, stale-source rejection, unlink/relink, unfriend and admin prompt passed');
}finally{await db.close();}

const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try{
 const {applySemiContext}=await server.ssrLoadModule('/src/lib/semiSession.ts');
 const normal={systemParts:{core:'CORE',persona:'PC SELF',summary:'OWN MEMORY',userNote:'SECRET',keywords:''},messages:[{role:'user',content:'INPUT'}]};
 assert.equal(applySemiContext(normal,null),normal,'unlinked ordinary payload is untouched');
 const peer={persona:{name:'LEON',description:'MERCHANT'},content:'PEER MEMORY'};
 const result=applySemiContext(normal,{prompt:'SEMI RULES',peer});
 assert.equal(result.systemParts.core,'CORE\n\nSEMI RULES');assert.match(result.systemParts.persona,/# PC2 Information\nPC2 Name: LEON/);
 assert.match(result.systemParts.summary,/OWN MEMORY[\s\S]*# PC2 Session Summary\nPEER MEMORY/);
 assert.deepEqual(result.messages,normal.messages);assert.equal(result.systemParts.userNote,'SECRET');
 assert.equal(normal.systemParts.summary,'OWN MEMORY','application never mutates local memory');
 const empty=applySemiContext(normal,{prompt:'RULES',peer:null});assert.equal(empty.systemParts.summary,'OWN MEMORY');
 console.log('Semi payload: ordinary identity, peer PC2 identity, summary separation and original user-input roles passed');
}finally{await server.close();}
