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
 let prompt=(await q('select summary_prompt from platform_config where id=1'))[0].summary_prompt;assert.equal(prompt,'ADMIN EXACT\nSUMMARY','configured admin prompt migrates verbatim');
 assert.equal((await q("select count(*)::int n from profiles where summary_prompt is not null or summary_extra_note<>''"))[0].n,0,'no personal prompt data remains');
 await db.exec(`create or replace function auth.email() returns text language sql stable as $$select current_setting('test.email',true)$$;`);
 await login(b);await q("select set_config('test.email','b@test',false)");
 assert.equal((await q('select summary_prompt from platform_config where id=1'))[0].summary_prompt,prompt);
 await assert.rejects(()=>rpc('save_global_summary_prompt',[prompt,'user override']),/관리자/);
 assert.deepEqual(await q("update platform_config set summary_prompt='direct override' where id=1 returning id"),[]);
 await q("update profiles set display_name='Unrelated change',summary_prompt='private',summary_extra_note='memory note',summary_level=0,summary_allow_omission=false,summary_parameters_enabled=false where id=$1",[b]);
 const own=(await q('select * from profiles where id=$1',[b]))[0];assert.equal(own.summary_prompt,null);assert.equal(own.summary_extra_note,'memory note');assert.equal(own.summary_level,0);assert.equal(own.summary_allow_omission,false);assert.equal(own.summary_parameters_enabled,false);assert.equal(own.display_name,'Unrelated change');
 await q("update profiles set display_name='Second save' where id=$1",[b]);assert.equal((await q('select summary_level from profiles where id=$1',[b]))[0].summary_level,0,'unrelated saves no longer reset parameters');
 await assert.rejects(()=>q('update profiles set summary_level=11 where id=$1',[b]));
 await login(a);await q("select set_config('test.email','topshjtv@gmail.com',false)");
 assert.equal(await rpc('save_global_summary_prompt',[prompt,'NEW GLOBAL']),true);assert.equal(await rpc('save_global_summary_prompt',[prompt,'NEW GLOBAL']),true,'replay after a lost acknowledgement is idempotent');
 await assert.rejects(()=>rpc('save_global_summary_prompt',[prompt,'stale overwrite']),/변경/);await assert.rejects(()=>rpc('save_global_summary_prompt',['NEW GLOBAL','   ']));
 await q("insert into works(id,creator_id,title,visibility) values($1,$2,'Fixture','public')",[work,a]);
 assert.ok(await rpc('create_session_with_start',[work,null,null]),'new-session creation remains compatible with retired columns');
 await login(b);const created=await rpc('create_session_with_start',[work,null,null]);
 assert.deepEqual((await q('select summary_level_override,summary_allow_omission_override,summary_parameters_enabled_override from sessions where id=$1',[created]))[0],{summary_level_override:0,summary_allow_omission_override:false,summary_parameters_enabled_override:false},'new rooms snapshot the original personal defaults');
 await q('update sessions set summary_level_override=10,summary_parameters_enabled_override=true where id=$1',[created]);
 await q("update sessions set user_note='unrelated save' where id=$1",[created]);
 assert.equal((await q('select summary_level_override from sessions where id=$1',[created]))[0].summary_level_override,10,'room values persist across subsequent writes');
 await assert.rejects(()=>q('update sessions set summary_level_override=-1 where id=$1',[created]));
 await login(a);assert.deepEqual(await q('update sessions set summary_level_override=7 where id=$1 returning id',[created]),[],'another user cannot change room parameters');
 await db.exec('reset role');
 const restore=readFileSync(new URL(readdirSync(dir).find(file=>file.endsWith('_restore_summary_parameters.sql')),dir),'utf8');
 await db.exec(restore);
 assert.equal((await q('select summary_level_override from sessions where id=$1',[created]))[0].summary_level_override,10,'reapplying does not reset saved values');
 assert.equal((await q('select summary_extra_note from profiles where id=$1',[b]))[0].summary_extra_note,'memory note');
 await login(null);await assert.rejects(()=>rpc('save_global_summary_prompt',['NEW GLOBAL','anon']));
 console.log('Global summary DB: shared admin prompt, restored personal/room parameters, persistence, snapshot defaults, bounds, RLS, non-destructive migration replay and atomic admin save passed');
}finally{await db.close();}
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
const originalFetch=globalThis.fetch;
try{
 let value='GLOBAL CURRENT',error=false;globalThis.fetch=async()=>new Response(JSON.stringify(error?{message:'denied'}:{summary_prompt:value}),{status:error?403:200,headers:{'content-type':'application/json'}});
 const {loadGlobalSummaryPrompt,summaryPromptWithParameters}=await server.ssrLoadModule('/src/lib/summaryPrompt.ts');
 assert.equal(await loadGlobalSummaryPrompt(),'GLOBAL CURRENT');value='GLOBAL CHANGED';assert.equal(await loadGlobalSummaryPrompt(),'GLOBAL CHANGED','subsequent summaries read live global state');
 value='';await assert.rejects(()=>loadGlobalSummaryPrompt(),/전역/);error=true;await assert.rejects(()=>loadGlobalSummaryPrompt());
 const base='GLOBAL EXACT\nPROMPT',profile={summary_level:3,summary_allow_omission:true,summary_parameters_enabled:true,summary_extra_note:'  EXTRA NOTE  '};
 assert.equal(summaryPromptWithParameters(base,{},{}),base+'\n\n[SUMMARY CONFIGURATION]\nSUMMARY_LEVEL = 5\nALLOW_OMISSION = ON');
 assert.equal(summaryPromptWithParameters(base,profile,{summary_level_override:0,summary_allow_omission_override:false}),base+'\n\n[SUMMARY CONFIGURATION]\nSUMMARY_LEVEL = 0\nALLOW_OMISSION = OFF\n\n[ADDITIONAL NOTE]\nEXTRA NOTE');
 assert.equal(summaryPromptWithParameters(base,profile,{summary_parameters_enabled_override:false}),base+'\n\n[ADDITIONAL NOTE]\nEXTRA NOTE','disabling parameters keeps the original independent extra-note behavior');
 assert.equal(summaryPromptWithParameters(base,{...profile,summary_extra_note:' ',summary_parameters_enabled:false},{}),base,'OFF with no note preserves the exact shared instruction');
 assert.match(summaryPromptWithParameters(base,profile,{summary_level_override:null,summary_allow_omission_override:null}),/SUMMARY_LEVEL = 3\nALLOW_OMISSION = ON/,'null room overrides inherit personal values');
 globalThis.window={location:{origin:'https://summary.test'}};
 const {generate}=await server.ssrLoadModule('/src/lib/llm/index.ts');
 let sent;globalThis.fetch=async(_url,options)=>{sent=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'summary'}}],usage:{prompt_tokens:1,completion_tokens:1,cost:0}}));};
 const core=summaryPromptWithParameters(base,profile,{summary_level_override:10,summary_allow_omission_override:false});
 await generate('openrouter',{apiKey:'fixture',model:'fixture/model',sessionId:'fixture:summary',reasoning:{send:false},maxOutputTokens:4096,systemParts:{core,persona:'',userNote:'',summary:'',keywords:''},messages:[{role:'user',content:'DIALOGUE'}]});
 assert.equal(sent.messages[0].content,core,'exact controls reach the real serialized HTTP body');
 delete globalThis.window;
 console.log('Global summary loader: fresh shared value, no fallback/personalization, explicit missing/denied errors passed');
}finally{globalThis.fetch=originalFetch;await server.close();}
