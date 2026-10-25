import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createClient} from '@supabase/supabase-js';
import ts from 'typescript';
import vm from 'node:vm';
const compile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const uri=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const storage=new Map();let blocked=false;
globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>{if(blocked)throw Error('quota');storage.set(k,v)},removeItem:k=>storage.delete(k)};
let mode,remote,posts,commits;
const original={id:'response',session_id:'room',content:'',generation_status:'streaming',usage_accounted:false};
const client=createClient('https://recovery.test','fake-key',{auth:{persistSession:false,autoRefreshToken:false},db:{retry:false},global:{fetch:async(input,init)=>{
 const url=new URL(input),json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 if(init.method==='GET')return json(url.pathname.endsWith('/messages')?(remote?[remote]:[]):{id:'room',total_cost:0.02});
 posts++;
 if(mode==='denied')return new Response(JSON.stringify({code:'42501',message:'denied'}),{status:403});
 if(mode==='never'||(mode==='before'&&posts===1))throw new TypeError('Load failed');
 const args=JSON.parse(init.body);
 if(!remote.usage_accounted){remote={...remote,content:args.response_text,generation_status:args.target_message&&url.pathname.endsWith('interrupt_session_response')?'interrupted':'complete',usage_accounted:!url.pathname.endsWith('interrupt_session_response')};commits++;}
 if(mode==='after'&&posts===1)throw new TypeError('Load failed');
 if(mode==='body'&&posts===1)return new Response(new ReadableStream({start(c){c.error(new TypeError('Load failed'))}}),{headers:{'content-type':'application/json'}});
 return json({message:remote,session:{id:'room'},contextConflict:false});
}}});
globalThis.__responseClient=client;
const stub=uri('export const supabase=globalThis.__responseClient;');
const recovery=await import(uri(compile(read('src/lib/responseRecovery.ts')).replace("'./supabase'",JSON.stringify(stub))));
const args={target_session:'room',target_message:'response',response_text:'FULL ANSWER',in_tokens:1,out_tokens:2,response_cost:0.02,read_tokens:null,write_tokens:null,target_group:null,previous_message:null,previous_summary:'',previous_summary_turn:0,restored_summary:null,restored_summary_turn:null,restored_versions:null};
function reset(next){mode=next;remote={...original};posts=commits=0;}
for(const scenario of ['normal','before','after','body']){
 reset(scenario);recovery.retainResponse('owner',args);
 const result=await recovery.commitResponse(args);assert.equal(result.message.content,args.response_text);assert.equal(commits,1);assert(posts<=2);
 recovery.forgetResponse('owner',args);assert.equal(recovery.pendingResponse('owner','room'),null);
}
reset('never');recovery.retainResponse('owner',args);await assert.rejects(recovery.commitResponse(args));assert.equal(posts,2);assert.equal(recovery.pendingResponse('owner','room').response_text,'FULL ANSWER');
assert.equal(recovery.pendingResponse('other-account','room'),null);
reset('denied');await assert.rejects(recovery.commitResponse(args));assert.equal(posts,1);assert.equal(commits,0);
blocked=true;const newer={...args,target_message:'new-response'};assert.equal(recovery.retainResponse('owner',newer),false);assert.equal(recovery.pendingResponse('owner','room').target_message,'new-response');recovery.forgetResponse('owner',args);assert.equal(recovery.pendingResponse('owner','room').target_message,'new-response');blocked=false;
reset('normal');const partial={...args,interrupted:true,response_text:'PARTIAL'};const saved=await recovery.commitResponse(partial);assert.equal(saved.message.generation_status,'interrupted');assert.equal(remote.usage_accounted,false);

function declaration(path,name){const f=ts.createSourceFile(path,read(path),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let found;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)found=n.getText(f);ts.forEachChild(n,visit)}visit(f);assert(found,name);return compile(found);}
const call=(path,name,env)=>vm.runInNewContext(declaration(path,name)+'\n'+name,env);
// Actual editor handler: a successful old snapshot must not erase newer edits.
for(const changed of [false,true]){
 const store=new Map([['draft','NEWER COPY']]);let finish;
 const work={id:'work',title:'submitted'},starts=[{id:'start'}],keywords=[];
 const current=changed?{...work,title:'newer'}:work;
 const env={work,workId:'work',ready:true,serverBaselineRef:{current:{work,starts,keywords}},saveLockRef:{current:false},structureLockRef:{current:false},setSaveAttempted:()=>{},canSave:true,noConfigs:false,hasConfigErrors:false,setTab:()=>{},startConfigs:starts,keywordBooks:keywords,snapshot:(...x)=>JSON.stringify(x),setSaving:()=>{},saveWorkEditor:()=>new Promise(r=>finish=r),editorRouteRef:{current:'work'},baselineRef:{current:''},latestEditRef:{current:{work:current,startConfigs:starts,keywordBooks:keywords,kwInputs:{}}},dirtyRef:{current:true},setDirty:()=>{},localStorage:{removeItem:k=>store.delete(k)},draftKey:()=> 'draft',showToast:()=>{},saveErrorMessage:e=>e.message};
 const pending=call('src/pages/WorkEditorPage.tsx','save',env)();finish();await pending;
 assert.equal(env.dirtyRef.current,changed);assert.equal(store.has('draft'),changed);
}
// Failed save leaves dirty state and draft untouched, including a zero-row RPC error.
{
 let removed=false;const env={work:{id:'work'},ready:true,serverBaselineRef:{current:{}},saveLockRef:{current:false},structureLockRef:{current:false},setSaveAttempted:()=>{},canSave:true,noConfigs:false,hasConfigErrors:false,setTab:()=>{},startConfigs:[],keywordBooks:[],snapshot:()=>'',setSaving:()=>{},saveWorkEditor:async()=>{throw Error('zero rows')},editorRouteRef:{current:'work'},dirtyRef:{current:true},localStorage:{removeItem:()=>removed=true},showToast:()=>{},saveErrorMessage:e=>e.message};
 await call('src/pages/WorkEditorPage.tsx','save',env)();assert.equal(removed,false);assert.equal(env.dirtyRef.current,true);
}
// Failed global read never marks the form ready; the save guard cannot issue a write.
{
 let writes=0;const env={isAdmin:true,systemPromptLoaded:false,systemPromptBaseline:{current:null},systemPromptLock:{current:false},supabase:{from:()=>writes++}};
 await call('src/pages/SettingsPage.tsx','saveSystemPrompt',env)();assert.equal(writes,0);
}
console.log('Recovery client: actual SDK bounded commits/replies/body loss/denial, retained complete and interrupted answers, quota fallback, stale-copy protection, actual editor concurrency and failed-global-load guard passed');
delete globalThis.__responseClient;
