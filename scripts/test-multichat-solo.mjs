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
   // Production enforces non-null cache counters on the canonical transcript.
   // Keep that stricter schema here so nullable multichat usage cannot hide bugs.
   await db.exec(`alter table messages alter column cache_read_tokens set default 0, alter column cache_read_tokens set not null,
    alter column cache_write_tokens set default 0, alter column cache_write_tokens set not null;
    insert into auth.users(id,email) values('${a}','a@example.test'),('${b}','b@example.test'),('${c}','c@example.test');
    insert into works(id,creator_id,title) values('10000000-0000-0000-0000-000000000009','${a}','Legacy work');
    insert into multichat_rooms(id,work_id,host_user_id,title,model,status,current_round,total_cost) values('20000000-0000-0000-0000-000000000009','10000000-0000-0000-0000-000000000009','${a}','Legacy room','fixture/plain','active',2,0.03);
    insert into multichat_members(room_id,user_id,slot) values('20000000-0000-0000-0000-000000000009','${a}',1);
    insert into multichat_messages(id,room_id,round_number,role,content) values('30000000-0000-0000-0000-000000000009','20000000-0000-0000-0000-000000000009',1,'user','PRESERVED USER'),('40000000-0000-0000-0000-000000000009','20000000-0000-0000-0000-000000000009',1,'assistant','PRESERVED ANSWER');`);
  }
  try{await db.exec(source);}catch(error){throw new Error(file+': '+error.message);}
 }
 await db.exec(`grant usage on schema public,auth to authenticated,anon;grant select,insert,update,delete on all tables in schema public to authenticated;
 insert into auth.users(id,email) values('${a}','a@example.test'),('${b}','b@example.test'),('${c}','c@example.test') on conflict(id) do nothing;
 insert into works(id,creator_id,title,visibility,main_prompt,multichat_prompt) values('${work}','${a}','Main','private','MAIN','MULTI');
 insert into multichat_rooms(id,work_id,host_user_id,title,model) values('${room}','${work}','${a}','Public room','fixture/plain');
 insert into multichat_members(room_id,user_id,slot) values('${room}','${a}',1);
 insert into personas(user_id,name,description,is_default) values('${a}','누리','HOST PERSONA',true),('${b}','소희','GUEST PERSONA',true);`);
 assert.equal((await query("select content from messages where id='40000000-0000-0000-0000-000000000009'"))[0].content,'PRESERVED ANSWER');
 assert.equal(Number((await query("select total_cost from sessions where id='20000000-0000-0000-0000-000000000009'"))[0].total_cost),0.03);
 await db.exec("delete from multichat_rooms where id='20000000-0000-0000-0000-000000000009'");
 await login(b);await rpc('join_multichat_room',[room]);
 await login(a);await rpc('start_multichat',[room]);
 const current=async()=>(await query('select * from multichat_rooms where id=$1',[room]))[0];
 const mode=async(value,revision)=>{await rpc('set_multichat_progress',[room,value,revision??(await current()).progress_revision]);return current();};
 const finish=async ticket=>rpc('finish_multichat_response',[ticket.messageId,ticket.token,'answer',1,2,0.001,null,null,false]);
 const submit=async(text='action',revision)=>rpc('submit_multichat_action_checked',[room,(await current()).current_round,revision??(await current()).progress_revision,text]);
 await login(null);await assert.rejects(()=>rpc('set_multichat_progress',[room,'solo',0]));
 await login(c);await assert.rejects(()=>rpc('set_multichat_progress',[room,'solo',0]));
 await login(b);let r=await mode('solo',0);assert.equal(r.solo_slot,2,'guest solo keeps PC2');
 await login(a);await assert.rejects(()=>mode('solo',0),/다른 참여자/,'concurrent stale selection cannot overwrite PC2');
 await assert.rejects(()=>rpc('submit_multichat_turn',[room,'legacy input']),/혼자 진행/);
 await assert.rejects(()=>submit('stale input',0),/변경/);
 assert.equal(await rpc('claim_multichat_response',[room]),null);
 await login(b);assert.equal(await rpc('multichat_payer_slot',[room,1]),2,'solo PC2 uses local PC2 key even with PC1 billing');
 await rpc('set_multichat_billing',[room,'pc1',1,1,1]);await submit('guest solo');
 assert.equal(await rpc('multichat_input',[room,1]),'소희(PC2): guest solo','no synthetic PC1/skip/generic PC');
 let ticket=await rpc('claim_multichat_response',[room]);assert.equal(ticket.slot,2);assert.equal(ticket.progressMode,'solo');assert.equal(ticket.activeSlot,2);
 assert.equal(await rpc('claim_multichat_response',[room]),null,'second generation is not claimed');
 await login(a);await mode('together');
 await rpc('set_multichat_billing',[room,'pc1',1,1,1]);
 await login(b);await rpc('finish_multichat_response',[ticket.messageId,ticket.token,'partial',0,0,0,null,null,true]);
 await login(a);assert.equal(await rpc('claim_multichat_response',[room,true]),null,'retry retains PC2 even after mode/key rules change');
 await login(b);ticket=await rpc('claim_multichat_response',[room,true]);assert.equal(ticket.activeSlot,2);assert.equal(ticket.progressMode,'solo');await finish(ticket);
 // Rerolling an old solo turn retains both its mode and its PC identity.
 await login(a);await rpc('request_multichat_reroll',[room]);await rpc('set_multichat_billing',[room,'pc1',1,1,1]);
 assert.equal(await rpc('claim_multichat_response',[room]),null);
 await login(b);const reroll=await rpc('claim_multichat_response',[room]);assert.equal(reroll.activeSlot,2);assert.equal(reroll.progressMode,'solo');await finish(reroll);
 // Shared mode still requires two real actions, and explicit skip stays shared.
 await login(a);await submit('host shared');assert.equal(await rpc('claim_multichat_response',[room]),null);
 await login(b);await assert.rejects(()=>mode('solo'),/이미 입력/,'existing peer submission cannot be discarded');await submit('');
 await login(a);ticket=await rpc('claim_multichat_response',[room]);assert.equal(ticket.progressMode,'together');assert.equal(ticket.activeSlot,null);
 assert.ok((await rpc('multichat_input',[room,2])).includes('소희(PC2): [skip]'));
 // Select PC1 solo during a shared generation; it starts on the next turn.
 await mode('solo');assert.equal(ticket.progressMode,'together');await finish(ticket);
 await submit('host solo');ticket=await rpc('claim_multichat_response',[room]);assert.equal(ticket.activeSlot,1);await finish(ticket);
 // A solo -> shared -> PC2 change keeps the original member slots/personas/notes.
 await login(b);await mode('solo');assert.equal((await current()).solo_slot,2);
 assert.deepEqual((await query('select slot from multichat_members where room_id=$1 order by slot',[room])).map(m=>m.slot),[1,2]);
 await submit('guest solo again');ticket=await rpc('claim_multichat_response',[room]);assert.equal(ticket.activeSlot,2);await finish(ticket);
 await assert.rejects(async()=>rpc('submit_multichat_action_checked',[room,1,(await current()).progress_revision,'late']),/변경/);
 const before=(await current()).billing_mode;assert.equal(before,'pc1','solo does not rewrite the shared billing configuration');
 // Summary works with the solo player's key while the other player is away.
 await rpc('request_multichat_summary',[room,4,[]]);const summary=await rpc('claim_multichat_summary',[room]);assert.ok(summary?.token);
 await rpc('fail_multichat_summary',[room,summary.id,summary.token,'fixture pause']);
 await login(a);await assert.rejects(()=>rpc('set_multichat_progress',[room,'solo',null]),/다른 참여자/);
 console.log('Solo multichat DB: fixed PC1/PC2, guest/host switching, stale mode/input requests, peer submission preservation, single claim, frozen retry/reroll, shared skip and solo summary/key assignment passed');
}finally{await db.close();}
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try{
 const {applyMultichatTurnState,multichatRoundReady,multichatGenerationSlot}=await server.ssrLoadModule('/src/lib/multichat.ts');
 const parts={core:'mode={{multichat_mode}} active={{multichat_active_pc}}',persona:'PC1: HOST\nPC2: GUEST',userNote:'both notes',summary:'memory',keywords:''};
 applyMultichatTurnState(parts,{progressMode:'solo',activeSlot:2});
 assert.equal(parts.core,'mode=solo active=PC2');assert.equal(parts.persona,'PC1: HOST\nPC2: GUEST');assert.ok(parts.keywords.includes('multichat_active_pc=PC2'));
 assert.ok(!parts.keywords.includes('multichat_active_pc=PC1'));
 const solo={current_round:5,progress_mode:'solo',solo_slot:2};
 assert.equal(multichatRoundReady(solo,[{round_number:5,slot:2}]),true);
 assert.equal(multichatRoundReady(solo,[{round_number:5,slot:1}]),false);
 assert.equal(multichatRoundReady(solo,[{round_number:5,slot:2,optimistic:true}]),false);
 assert.equal(multichatRoundReady(solo,[{round_number:5,slot:1},{round_number:5,slot:2}]),false);
 assert.equal(multichatGenerationSlot(5,{...solo,billing_mode:'pc1'}),2);
 assert.equal(multichatGenerationSlot(5,{...solo,progress_mode:'together',billing_mode:'pc1'}),1);
 console.log('Solo multichat prompt: metadata and editable variables retain PC2, both mappings/memory stay intact, one confirmed input triggers the original PC slot');
}finally{await server.close();}
