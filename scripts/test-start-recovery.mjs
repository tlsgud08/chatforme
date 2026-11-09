import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
let scenario, posts, reads, creates, rows;
const args = { target_session:'room',response_id:'response',user_message_id:'user',user_text:'retain this input',
  user_command_id:null,user_command_name:null,user_command_prompt:null,source_versions:[],expected_summary:'',
  expected_summary_turn:0,reroll_message:null,requested_turn:1,requested_variant:1 };
const json = data => new Response(JSON.stringify(data), { headers:{'content-type':'application/json'} });
const client = createClient('https://start-recovery.test','fixture',{
  auth:{persistSession:false,autoRefreshToken:false},db:{retry:false},global:{fetch:async(input,init)=>{
    const url = new URL(input);
    if(init.method==='GET'){
      reads++;
      if(scenario==='unconfirmed'||(scenario==='two-lost-replies'&&posts===1))throw new TypeError('Load failed');
      return json(rows.filter(row=>'eq.'+row.id===url.searchParams.get('id')));
    }
    if(scenario.startsWith('resume-')) {
      assert(url.pathname.endsWith('resume_session_response')); posts++;
      const actual=JSON.parse(init.body);
      assert.equal(actual.source_user,'user'); assert.equal(actual.requested_turn,7);
      assert(!('user_message_id' in actual) && !('reuse_user_message' in actual), 'resume cannot insert a duplicate user');
      if(scenario==='resume-old')return new Response(JSON.stringify({code:'PGRST202',message:'missing function'}),{status:404});
      if(scenario==='resume-before'&&posts===1)throw new TypeError('Load failed');
      if(!rows.length){creates++;rows=[{id:'response',session_id:'room',role:'assistant',turn_index:7,generation_status:'streaming'}];}
      if(scenario==='resume-lost')throw new TypeError('Load failed');
      return json({draft:rows[0],userMessage:null,replayed:false});
    }
    assert(url.pathname.endsWith('begin_session_response'),'no model call can be made by start recovery');posts++;
    const actual=JSON.parse(init.body);assert.equal(actual.response_id,args.response_id);assert.equal(actual.user_message_id,args.user_message_id);
    if(scenario==='denied')return new Response(JSON.stringify({code:'42501',message:'denied'}),{status:403});
    if(scenario==='generating')return new Response(JSON.stringify({code:'40001',message:'Another response is generating; refresh'}),{status:409});
    if(scenario==='unconfirmed'||(scenario==='before'&&posts===1))throw new TypeError('Load failed');
    const replayed=rows.length>0;
    if(!rows.length){creates++;rows=[{id:'response',session_id:'room',role:'assistant',generation_status:'streaming'},
      {id:'user',session_id:'room',role:'user',content:args.user_text}];}
    if(scenario==='lost-reply'||scenario==='two-lost-replies')throw new TypeError('Load failed');
    return json({draft:rows[0],userMessage:rows[1],replayed});
  }}
});
globalThis.__startRecovery=client;
const compiled=ts.transpileModule(readFileSync(new URL('../src/lib/responseRecovery.ts',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const stub=uri('export const supabase=globalThis.__startRecovery;');
const {beginResponse}=await import(uri(compiled.replace("'./supabase'",JSON.stringify(stub))));
function reset(next){scenario=next;posts=reads=creates=0;rows=[];}
try{
  for(const mode of ['normal','before','lost-reply','two-lost-replies']){
    reset(mode);const result=await beginResponse(args);
    assert.equal(result.draft.id,'response');assert.equal(result.userMessage.content,args.user_text);
    assert.equal(creates,1);assert(posts<=2);
    if(mode==='lost-reply')assert.equal(posts,1,'a confirmed start does not need another write');
    if(mode==='two-lost-replies')assert.equal(posts,2,'a lost second reply is confirmed through IDs');
  }
  reset('unconfirmed');await assert.rejects(beginResponse(args),/저장 여부를 확인하지 못/);assert.equal(posts,2);assert.equal(creates,0);
  reset('denied');await assert.rejects(beginResponse(args));assert.equal(posts,1);assert.equal(reads,0);
  reset('generating');await assert.rejects(beginResponse(args),/생성 중/);assert.equal(posts,1);assert.equal(reads,0);
  const resumed={...args,user_message_id:null,reuse_user_message:'user',requested_turn:7};
  for(const mode of ['resume-normal','resume-before','resume-lost']) {
    reset(mode); const result=await beginResponse(resumed);
    assert.equal(result.draft.turn_index,7);assert.equal(result.userMessage,null);assert.equal(creates,1);assert(posts<=2);
    if(mode==='resume-lost')assert.equal(posts,1,'a confirmed resume never repeats the claim');
  }
  reset('resume-old');await assert.rejects(beginResponse(resumed),/서버 업데이트/);assert.equal(posts,1);assert.equal(creates,0);
  console.log('Start recovery: real SDK stable IDs, before-write failure, both lost replies, explicit unknown/permission/generation states and one created pair passed');
}finally{delete globalThis.__startRecovery;}
