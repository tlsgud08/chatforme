import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createClient} from '@supabase/supabase-js';
const compile = s => ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const uri = s => 'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
// Measure real writer starts on a deterministic clock, including chunks arriving
// during a pending write. The old drain loop starts a second write at t=110.
let now=0, timerId=0; const timers=new Map(), writes=[]; let release;
const writerSource=compile(readFileSync(new URL('../src/lib/draftWriter.ts',import.meta.url),'utf8')).replace('export function','function');
const {createDraftWriter}=vm.runInNewContext(writerSource+'\n({createDraftWriter})',{
 setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{at:now+ms,fn});return id;},clearTimeout:id=>timers.delete(id),
});
const tick=async t=>{now=t;for(const [id,item] of [...timers])if(item.at<=now){timers.delete(id);item.fn();}for(let i=0;i<8;i++)await Promise.resolve();};
const writer=createDraftWriter(async text=>{writes.push({text,at:now});if(writes.length===1)await new Promise(r=>release=r);},100);
writer.push('first');await tick(100);writer.push('during first write');now=110;release();await tick(110);
assert.equal(writes.length,1,'chunks received during a write cannot bypass the save interval');
writer.push('latest');await tick(209);assert.equal(writes.length,1);await tick(210);
assert.equal(writes.length,2);assert.equal(writes[1].text,'latest');
writer.push('final');await writer.flush();assert.equal(writes.at(-1).text,'final','flush saves the latest text without a timer wait');
writer.push('discard after final commit');await writer.stop();await tick(1000);assert.equal(writes.length,3);

const original={id:'m',session_id:'s',content:'old',command_id:null,command_name:null,content_version:0};
let remote, mode, patches, commits, reads, late;
const client=createClient('https://edit.test','mock-key',{auth:{persistSession:false,autoRefreshToken:false},db:{retry:false},global:{fetch:async(input,init)=>{
 const url=new URL(input);
 if(init.method==='GET'){
  reads++;
  if(mode==='unconfirmed')throw new TypeError('Load failed');
  return new Response(JSON.stringify(remote?[remote]:[]),{headers:{'content-type':'application/json'}});
 }
 assert.equal(init.method,'POST');patches++;
 const args=JSON.parse(init.body),patch={content:args.message_text,command_id:args.command_uuid,command_name:args.command_label};
 const response=()=>new Response(JSON.stringify({message:remote,session:{id:'s'},replacement:null,deleted:false}),{headers:{'content-type':'application/json'}});
 if(mode==='denied')return new Response(JSON.stringify({code:'42501',message:'denied'}),{status:403});
 if(remote.content===patch.content&&remote.command_id===patch.command_id&&remote.command_name===patch.command_name)return response();
 const apply=()=>{if(remote.content!==patch.content)remote.content_version++;Object.assign(remote,patch);commits++;};
 if(patches===1&&['before','conflict','command-conflict','unconfirmed','late','twice'].includes(mode)){
  if(mode==='conflict'){remote.content='someone else';remote.content_version++;}
  if(mode==='command-conflict')remote.command_name='changed';
  if(mode==='late')late=apply;
  throw new TypeError('Load failed');
 }
 if(late){late();late=undefined;}
 if(remote.content===patch.content&&remote.command_id===patch.command_id&&remote.command_name===patch.command_name)return response();
 const guarded=remote&&args.expected_version===remote.content_version&&args.expected_command_name===remote.command_name;
 if(mode==='twice')throw new TypeError('Load failed');
 if(!guarded)return new Response(JSON.stringify({code:'40001',message:'changed'}),{status:409});
 apply();
 if(patches===1&&mode==='body')return new Response(new ReadableStream({start(controller){controller.error(new TypeError('Load failed'));}}),{headers:{'content-type':'application/json'}});
 if(patches===1&&mode==='after')throw new TypeError('Load failed');
 return response();
}}});
globalThis.__messageEditTest=client;
const stub=uri('export const supabase=globalThis.__messageEditTest;');
const moduleSource=compile(readFileSync(new URL('../src/lib/messageMutations.ts',import.meta.url),'utf8')).replace("'./supabase'",`'${stub}'`);
const {mutateMessage}=await import(uri(moduleSource));
const saveMessageEdit=(original,patch)=>mutateMessage(original,patch).then(result=>result.message);
const patch={content:'new',command_id:null,command_name:null};
function reset(next){mode=next;remote={...original};patches=commits=reads=0;late=undefined;}
try{
 for(const scenario of ['normal','before','after','body','late']){
  reset(scenario);const saved=await saveMessageEdit({...original},patch);
  assert.equal(saved.content,'new');assert.equal(saved.content_version,1);assert.equal(commits,1,scenario+' cannot repeat a committed edit');
  assert.equal(patches,scenario==='normal'?1:2);
 }
 for(const scenario of ['conflict','command-conflict']){
  reset(scenario);await assert.rejects(saveMessageEdit({...original},patch),/메시지가 변경/);assert.equal(patches,1);assert.equal(commits,0);
 }
 reset('unconfirmed');await assert.rejects(saveMessageEdit({...original},patch),/저장 여부를 확인하지 못/);assert.equal(patches,1);
 reset('denied');await assert.rejects(saveMessageEdit({...original},patch));assert.equal(patches,1);assert.equal(reads,0);
 reset('twice');await assert.rejects(saveMessageEdit({...original},patch));assert.equal(patches,2);assert.equal(commits,0);
 reset('normal');remote.content_version=2;remote.content='changed';await assert.rejects(saveMessageEdit({...original},patch),/메시지가 변경/);assert.equal(commits,0);
 console.log('Save stability: bounded draft cadence, immediate flush, lost edit acknowledgement, one guarded retry, late commit, conflicts, permissions and retained unconfirmed drafts passed');
}finally{delete globalThis.__messageEditTest;}
