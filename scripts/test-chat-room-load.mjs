import assert from 'node:assert/strict';
import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try{
 const {supabase}=await server.ssrLoadModule('/src/lib/supabase.ts');
 const {loadChatRoom,loadChatContext}=await server.ssrLoadModule('/src/lib/chatRoomData.ts');
 const savedFrom=supabase.from,savedRpc=supabase.rpc;
 let release,blocked=false,failTable=null,requests=[];
 function q(table){let signal;const query={select(){return this},eq(){return this},order(){return this},single(){return this},abortSignal(s){signal=s;return this},then(resolve,reject){
  requests.push(table);
  return (async()=>{if(table==='platform_config'&&blocked)await new Promise(r=>release=r);signal?.throwIfAborted();
   const data=table==='sessions'?{id:'room',user_id:'user',work_id:'work',persona_id:null,start_config_id:null}:table==='works'?{id:'work'}:table==='profiles'?{id:'user'}:table==='platform_config'?{system_prompt:'required core',theme_prompt:''}:table==='rpc'?{messages:[{id:'history'}],hasOlder:false,oldestTurn:null,totalUserTurns:1}:[];
   return {data,error:table===failTable?{message:'injected '+table+' failure'}:null};})().then(resolve,reject);
 }};return query;}
 supabase.from=q;supabase.rpc=()=>q('rpc');
 const callbacks=events=>({display:(s,w,p)=>events.push(['display',s.id,w.id,p.messages[0].id]),context:c=>events.push(['context',c.systemPrompt]),displayError:e=>events.push(['display-error',e.message]),contextError:e=>events.push(['context-error',e.message])});
 const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve()};
 try{
  blocked=true;const events=[],controller=new AbortController();
  const pending=loadChatRoom('room','user',controller.signal,callbacks(events));await settle();
  assert.equal(events[0]?.[0],'display','the actual display callback cannot wait for prompt data');
  assert.equal(events.length,1);
  release();await pending;assert.equal(events[1][0],'context');
  blocked=false;failTable='platform_config';const failed=[];
  await loadChatRoom('room','user',new AbortController().signal,callbacks(failed));
  assert(failed.some(e=>e[0]==='display'));assert(failed.some(e=>e[0]==='context-error'));
  assert(!failed.some(e=>e[0]==='display-error'),'failed settings cannot erase readable history');
  failTable=null;blocked=true;const abandoned=[],old=new AbortController();
  const oldLoad=loadChatRoom('room','user',old.signal,callbacks(abandoned));await settle();old.abort();release();await oldLoad;
  assert(!abandoned.some(e=>e[0]==='context'),'late settings from an abandoned route cannot apply');
  const alreadyCancelled=new AbortController();alreadyCancelled.abort();requests=[];
  await loadChatRoom('room','user',alreadyCancelled.signal,callbacks([]));
  blocked=false;failTable='works';const noWork=[];await loadChatRoom('room','user',new AbortController().signal,callbacks(noWork));
  assert(noWork.some(e=>e[0]==='display-error'));assert(!noWork.some(e=>e[0]==='display'));
  failTable=null;const retry=await loadChatContext({id:'room',work_id:'work'},'user',new AbortController().signal);
  assert.equal(retry.systemPrompt,'required core');
  console.log('Chat room data: progressive display, explicit prompt failure, route cancellation, inaccessible work and complete context retry passed');
 }finally{supabase.from=savedFrom;supabase.rpc=savedRpc;}
}finally{await server.close()}
