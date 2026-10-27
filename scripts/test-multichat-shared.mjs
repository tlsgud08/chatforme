import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'vite';
const dir = new URL('../supabase/migrations/', import.meta.url), db = new PGlite();
const a='00000000-0000-0000-0000-000000000001',b='00000000-0000-0000-0000-000000000002',c='00000000-0000-0000-0000-000000000003';
const work='10000000-0000-0000-0000-000000000001',room='20000000-0000-0000-0000-000000000001';
const query=async(sql,args=[]) => (await db.query(sql,args)).rows;
async function login(id){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);await db.exec(id?'set role authenticated':'set role anon');}
async function rpc(name,args=[]){const row=(await query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args))[0];return row?.value;}
try{
 await db.exec(`create role authenticated;create role anon;create role service_role;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.email() returns text language sql stable as $$select 'fixture@example.test'::text$$;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');`);
 for(const file of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort()){
  if(file.startsWith('0012_')||file.startsWith('0032_'))continue;
  let source=readFileSync(new URL(file,dir),'utf8');
  if(file.startsWith('0003_follows')||file.startsWith('0008_'))source=source.split('insert into storage.buckets')[0];
  source=source.replace(/create extension if not exists pgcrypto;/gi,'').replace(/do \$\$ begin alter publication[\s\S]*?end \$\$;/gi,'');
  if(file.endsWith('_multichat_shared_experience.sql')) {
   await db.exec(`insert into auth.users(id,email) values('${a}','a@example.test'),('${b}','b@example.test'),('${c}','c@example.test');
    insert into works(id,creator_id,title) values('10000000-0000-0000-0000-000000000009','${a}','Legacy work');
    insert into multichat_rooms(id,work_id,host_user_id,title,model,status,current_round,total_cost) values('20000000-0000-0000-0000-000000000009','10000000-0000-0000-0000-000000000009','${a}','Legacy room','fixture/plain','active',2,0.03);
    insert into multichat_members(room_id,user_id,slot) values('20000000-0000-0000-0000-000000000009','${a}',1);
    insert into multichat_messages(id,room_id,round_number,role,content) values('30000000-0000-0000-0000-000000000009','20000000-0000-0000-0000-000000000009',1,'user','PRESERVED USER'),('40000000-0000-0000-0000-000000000009','20000000-0000-0000-0000-000000000009',1,'assistant','PRESERVED ANSWER');`);
  }
  try{await db.exec(source);}catch(error){throw new Error(file+': '+error.message);}
 }
 await db.exec(`grant usage on schema public,auth to authenticated,anon;grant select,insert,update,delete on all tables in schema public to authenticated,anon;
 insert into auth.users(id,email) values('${a}','a@example.test'),('${b}','b@example.test'),('${c}','c@example.test') on conflict(id) do nothing;
 insert into works(id,creator_id,title,visibility,main_prompt,multichat_prompt) values('${work}','${a}','Main','private','MAIN','MULTI');
 insert into multichat_rooms(id,work_id,host_user_id,title,model) values('${room}','${work}','${a}','Public room','fixture/plain');
 insert into multichat_members(room_id,user_id,slot) values('${room}','${a}',1);
 insert into personas(user_id,name,description,is_default) values('${a}','누리','HOST PERSONA',true),('${b}','소희','GUEST PERSONA',true);`);
 assert.equal((await query("select content from messages where id='40000000-0000-0000-0000-000000000009'"))[0].content,'PRESERVED ANSWER');
 assert.equal(Number((await query("select total_cost from sessions where id='20000000-0000-0000-0000-000000000009'"))[0].total_cost),0.03);
 await db.exec("delete from multichat_rooms where id='20000000-0000-0000-0000-000000000009'");
 await login(c);assert.equal((await query('select id from multichat_rooms where id=$1',[room])).length,1,'outsider sees the room immediately');assert.equal((await query('select id from works where id=$1',[work])).length,1);assert.equal((await query('select id from sessions where id=$1',[room])).length,0);
 await assert.rejects(()=>rpc('set_multichat_billing',[room,'pc1',1,1,1]));
 await login(b);assert.equal(await rpc('join_multichat_room',[room]),room);assert.equal(await rpc('join_multichat_room',[room]),room,'join is idempotent');
 assert.equal((await query('select id from sessions where id=$1',[room])).length,1);
 await rpc('set_multichat_note',[room,'PC2 NOTE']);await rpc('set_multichat_billing',[room,'alternate',2,3,2]);
 assert.equal((await query('select billing_first_slot from multichat_rooms'))[0].billing_first_slot,2);
 await assert.rejects(()=>rpc('set_multichat_billing',[room,'alternate',0,3,1]));
 await login(a);await rpc('set_multichat_note',[room,'PC1 NOTE']);await rpc('set_multichat_billing',[room,'alternate',2,3,1]);await rpc('start_multichat',[room]);
 assert.deepEqual((await query('select user_note from multichat_members order by slot')).map(row=>row.user_note),['PC1 NOTE','PC2 NOTE']);
 const payers=[a,a,b,b,b,b,a];
 for(let round=1;round<=7;round++){
  await login(a);await rpc('submit_multichat_action',[room,'host '+round,null,null]);
  await login(b);assert.equal((await query('select content from multichat_submissions where round_number=$1',[round])).length,1,'input is visible before the peer submits');
  await rpc('submit_multichat_action',[room,'guest '+round,null,null]);
  const payer=payers[round-1],other=payer===a?b:a;
  await login(other);assert.equal(await rpc('claim_multichat_response',[room,false]),null);
  await login(payer);const ticket=await rpc('claim_multichat_response',[room,false]);assert.equal(ticket.round,round);assert.equal(await rpc('claim_multichat_response',[room,false]),null);
  assert.equal((await query("select content from messages where session_id=$1 and turn_index=$2 and role='user'",[room,round]))[0].content,`누리(PC1): host ${round}\n\n소희(PC2): guest ${round}`);
  if(round===3){await login(a);await rpc('set_multichat_billing',[room,'pc1',1,1,1]);await login(payer);}
  await rpc('stream_multichat_response',[ticket.messageId,ticket.token,'partial']);
  await login(other);await assert.rejects(()=>rpc('finish_multichat_response',[ticket.messageId,ticket.token,'forged',1,1,1,null,null,false]));
  await login(payer);await rpc('finish_multichat_response',[ticket.messageId,ticket.token,'answer '+round,10,20,0.01,2,0,false]);
  await rpc('finish_multichat_response',[ticket.messageId,ticket.token,'duplicate',10,20,0.01,2,0,false]);
  assert.equal((await query('select current_round from multichat_rooms'))[0].current_round,round+1);
  assert.equal((await query("select content from messages where id=$1",[ticket.messageId]))[0].content,'answer '+round);
  if(round===3){await login(b);await rpc('set_multichat_billing',[room,'alternate',2,3,2]);}
 }
 await login(b);await assert.rejects(()=>rpc('request_multichat_reroll',[room]));await assert.rejects(()=>rpc('claim_multichat_generation',[room,true]));
 await rpc('set_multichat_billing',[room,'pc2',1,1,1]);
 await login(a);await rpc('request_multichat_reroll',[room]);assert.equal(await rpc('claim_multichat_response',[room,false]),null);
 await login(b);const reroll=await rpc('claim_multichat_response',[room,false]);assert.equal(reroll.round,7);assert.equal(reroll.slot,2);await rpc('finish_multichat_response',[reroll.messageId,reroll.token,'rerolled',3,4,0.02,null,null,false]);
 assert.equal((await query('select current_round from multichat_rooms'))[0].current_round,8);
 assert.equal(Number((await query('select total_cost from sessions where id=$1',[room]))[0].total_cost),0.09);
 await assert.rejects(()=>rpc('edit_multichat_item',[room,'assistant',reroll.messageId,'forged']));
 await login(a);await rpc('edit_multichat_item',[room,'assistant',reroll.messageId,'host edit']);assert.equal((await query('select content from messages where id=$1',[reroll.messageId]))[0].content,'host edit');
 await assert.rejects(()=>rpc('branch_session_at_message',[room,reroll.messageId,'30000000-0000-0000-0000-000000000001',0]),/분기/);
 await login(b);const party=(await query('insert into multichat_party_messages(room_id,sender_user_id,content) values($1,$2,$3) returning id',[room,b,'HUMAN ONLY']))[0];
 assert.equal((await query("select id from messages where session_id=$1 and content='HUMAN ONLY'",[room])).length,0);
 await login(a);await rpc('request_multichat_summary',[room,7,[]]);assert.equal(await rpc('claim_multichat_summary',[room]),null,'host requests but cannot use the PC2-only key');
 await login(b);const summaryTicket=await rpc('claim_multichat_summary',[room]);assert.ok(summaryTicket.token);
 const versions=(await query('select id,content_version as version from messages where session_id=$1 and is_active_variant',[room]));
 await rpc('finish_multichat_summary',[room,summaryTicket.id,summaryTicket.token,'SHARED SUMMARY',7,'',1,2,0.001,JSON.stringify(versions)]);
 await rpc('finish_multichat_summary',[room,summaryTicket.id,summaryTicket.token,'SHARED SUMMARY',7,'',1,2,0.001,JSON.stringify(versions)]);
 await login(a);assert.equal((await query('select summary from sessions where id=$1',[room]))[0].summary,'SHARED SUMMARY');
 await rpc('edit_multichat_item',[room,'party',party.id,'CHANGED HUMAN ONLY']);assert.equal((await query('select summary from sessions where id=$1',[room]))[0].summary,'SHARED SUMMARY');
 await login(null);assert.equal((await query('select id from multichat_rooms')).length,0);
 console.log('Shared multichat DB: public lobby, direct join, independent notes, weighted/single payer and live changes, frozen claims, host-only rerolls/edits, canonical context, streaming, memory, no branching, idempotent costs passed');
}finally{await db.close();}
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try{
 const {multichatGenerationSlot}=await server.ssrLoadModule('/src/lib/multichat.ts');
 const policy={billing_mode:'alternate',billing_pc1_turns:2,billing_pc2_turns:3,billing_first_slot:1,billing_start_round:5};
 assert.deepEqual(Array.from({length:10},(_,index)=>multichatGenerationSlot(index+5,policy)),[1,1,2,2,2,1,1,2,2,2]);
 assert.deepEqual([1,2,3,4].map(round=>multichatGenerationSlot(round,{...policy,billing_mode:'pc2'})),[2,2,2,2]);
 console.log('Shared multichat billing client/SQL assignment parity passed');
 const originalFetch=globalThis.fetch,originalStorage=globalThis.localStorage;
 const extra='10000000-0000-0000-0000-000000000002';
 const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
 globalThis.window={location:{origin:'https://inuchat.test'}};
 const transcript=[
  {id:'hidden',role:'user',content:'HIDDEN SETUP',turn_index:0,is_hidden:true,is_active_variant:true,generation_status:'complete'},
  {id:'u1',role:'user',content:'누리(PC1): past\n\n소희(PC2): past',turn_index:1,is_hidden:false,is_active_variant:true,generation_status:'complete'},
  {id:'a1',role:'assistant',content:'PREVIOUS AI',turn_index:1,is_hidden:false,is_active_variant:true,generation_status:'complete'},
  {id:'u2',role:'user',content:'누리(PC1): terminal\n\n소희(PC2): guard',turn_index:2,is_hidden:false,is_active_variant:true,generation_status:'complete'},
 ];
 const session={id:room,user_id:a,work_id:work,multichat_room_id:room,work_combination_enabled:true,combined_work_ids:[extra],theme_override:null,summary:'SHARED MEMORY',summary_last_turn:1,active_plugins:[{id:'plugin',name:'style',prompt:'PLUGIN BODY'}],model_override:'fixture/plain',start_config_id:null,prompt_cache_enabled:false,output_settings_override_enabled:false};
 const palette={accent:'#111111',accentText:'#ffffff',main:'#ffffff',mainText:'#111111'};
 const themes=[{id:'scene1',name:'Scene one',work_id:work,owner_id:a,work_shared:true,dark_colors:palette,light_colors:palette},{id:'scene2',name:'Scene two',work_id:extra,owner_id:b,work_shared:false,dark_colors:palette,light_colors:palette}];
 let outgoing,requested=[];
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(String(input));requested.push(url.pathname);
  if(url.hostname==='openrouter.ai'){outgoing={headers:init.headers,body:JSON.parse(init.body)};return new Response('data: {"choices":[{"delta":{"content":"COMPLETE"}}]}\n\ndata: {"usage":{"prompt_tokens":9,"completion_tokens":8,"cost":0.01}}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}
  const table=url.pathname.split('/').at(-1),select=url.searchParams.get('select');
  let value;
  if(table==='sessions')value=session;
  else if(table==='platform_config')value={system_prompt:'PLATFORM',multichat_system_prompt:'MULTI RULES',theme_prompt:'THEME RULES',work_combination_prompt:'COMBINATION RULES'};
  else if(table==='multichat_members')value=[{slot:1,user_note:'PC1 NOTE',personas:{name:'누리',description:'HOST DESCRIPTION'}},{slot:2,user_note:'PC2 NOTE',personas:{name:'소희',description:'GUEST DESCRIPTION'}}];
  else if(table==='messages')value=transcript;
  else if(table==='story_notes')value=[{content:'STORY NOTE'}];
  else if(table==='keyword_books')value=[{keywords:['guard'],content:'KEYWORD BODY',activation_turns:3}];
  else if(table==='themes')value=themes;
  else if(table==='works')value=select==='*'?{id:work,title:'Main work',main_prompt:'MAIN BODY',multichat_prompt:'WORK MULTI BODY'}:select==='id,title,main_prompt'?[{id:extra,title:'Extra work',main_prompt:'EXTRA BODY'}]:[{id:work,title:'Main work'},{id:extra,title:'Extra work'}];
  else throw new Error('Unexpected read '+url);
  return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
 };
 try{
  const {prepareMultichatContext}=await server.ssrLoadModule('/src/lib/multichatContext.ts');
  const {generate}=await server.ssrLoadModule('/src/lib/llm/index.ts');
  const profile={default_model:'fixture/plain',default_reasoning:{send:false},default_output_tokens:2000,preferred_theme_variant:'light'};
  const prepared=await prepareMultichatContext(room,2,profile);
  assert.equal(prepared.catalog.themes.length,2,'both PCs can use the shared room’s readable work scenes');
  const context=JSON.stringify(prepared.assembled.systemParts);
  for(const marker of ['PLATFORM','MULTI RULES','MAIN BODY','EXTRA BODY','COMBINATION RULES','WORK MULTI BODY','HOST DESCRIPTION','GUEST DESCRIPTION','PC1 NOTE','PC2 NOTE','PLUGIN BODY','SHARED MEMORY','STORY NOTE','KEYWORD BODY','THEME RULES'])assert.ok(context.includes(marker),marker);
  assert.equal(prepared.assembled.messages.at(-1).content,transcript.at(-1).content);
  assert.ok(!prepared.assembled.messages.some(message=>message.content.includes('past')),'summarized history is omitted');
  await generate('openrouter',{apiKey:'PC2 LOCAL KEY',model:prepared.model,sessionId:room,...prepared.assembled,reasoning:prepared.reasoning,maxOutputTokens:prepared.maxOutputTokens,onChunk:()=>{}});
  assert.equal(outgoing.headers.authorization,'Bearer PC2 LOCAL KEY');
  assert.equal(outgoing.body.messages.at(-1).role,'user');
  assert.ok(outgoing.body.messages.every(message=>['system','user','assistant'].includes(message.role)));
  assert.ok(!requested.some(path=>path.includes('party')),'party messages are never read by the prompt pipeline');
  console.log('Shared multichat actual SDK → common assembler → HTTP adapter: both personas/notes, combination, themes, keyword books, memory, plugins, summary cutoff and valid PC input wire role passed');
 }finally{globalThis.fetch=originalFetch;globalThis.localStorage=originalStorage;}

}finally{await server.close();}
