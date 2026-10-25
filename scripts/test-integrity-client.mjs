import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const uri=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {createDraftWriter}=await import(uri(compile(readFileSync(new URL('../src/lib/draftWriter.ts',import.meta.url),'utf8'))));
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const writes=[];let release;
const writer=createDraftWriter(async text=>{writes.push(text);if(writes.length===1)await new Promise(resolve=>release=resolve);},1);
writer.push('first');await tick();
for(let n=0;n<100;n++)writer.push('latest '+n);
assert.equal(writes.length,1,'never start a second concurrent network write');
release();await writer.flush();
assert.deepEqual(writes,['first','latest 99']);
writer.push('must not overwrite the final response');await writer.stop();await tick();
assert.equal(writes.length,2);
const failed=createDraftWriter(async()=>{throw Error('offline');},1);
failed.push('partial');await assert.rejects(failed.flush(),/offline/);await failed.stop();

const taskModule=compile(readFileSync(new URL('../src/lib/accountTasks.ts',import.meta.url),'utf8'));
const {registerAccountTask,abortAccountTasks}=await import('data:text/javascript;base64,'+Buffer.from(taskModule).toString('base64'));
const continuing=new AbortController(),finished=new AbortController();
const stopContinuing=registerAccountTask(continuing),stopFinished=registerAccountTask(finished);
stopFinished();abortAccountTasks();stopContinuing();
assert.equal(continuing.signal.aborted,true,'account change cancels work even with no screen listeners');
assert.equal(finished.signal.aborted,false,'completed requests are removed');
const nextAccount=new AbortController(),unregisterNext=registerAccountTask(nextAccount);
stopContinuing();assert.equal(nextAccount.signal.aborted,false);unregisterNext();

const source=readFileSync(new URL('../src/pages/ChatPage.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function fn(name){let found;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)found=n.getText(ast);ts.forEachChild(n,visit);}visit(ast);assert.ok(found);return compile(found);}
const match=vm.runInNewContext(fn('getActiveKeywordContents')+'\ngetActiveKeywordContents',{keywordBooks:[{keywords:['trigger'],content:'lore',activation_turns:3}]});
assert.deepEqual(Array.from(match([{role:'user',content:'trigger'},{role:'user',content:'previous'}],'current')),['lore']);
assert.deepEqual(Array.from(match([{role:'user',content:'trigger'},{role:'user',content:'old'},{role:'user',content:'previous'}],'current')),[]);
assert.match(source,/getActiveKeywordContents\(baseMessages\.filter\(message => message\.id !== rerollUserMessage\?\.id\), promptText\)/,'real send path must exclude the current turn before the matching function appends it');

// Real generated-summary source with a concurrent generation must return before
// requesting a paid model or mutating memory.
let paidCalls=0;
const summary=vm.runInNewContext(fn('generateSummary')+'\ngenerateSummary',{
  contextReady:true,editInFlightRef:{current:false},deleteInFlightRef:{current:false},branchInFlightRef:{current:false},session:{id:'s'},profile:{},messages:[],sendInFlightRef:{current:true},generate:()=>paidCalls++,
});
await summary();assert.equal(paidCalls,0);

// Merging checkpoints from turns 10 and 20 must retain turn 20 even when
// the viewport contains only the final five user turns of a longer room.
const commits=[], summaryErrors=[], summaryRequests=[];
const complete=Array.from({length:30},(_,i)=>({id:'u'+i,role:'user',content:'turn '+(i+1),is_active_variant:true,generation_status:'complete'}));
const merging=vm.runInNewContext(fn('messagesThroughTurn')+'\n'+fn('generateSummary')+'\ngenerateSummary',{
  contextReady:true,editInFlightRef:{current:false},deleteInFlightRef:{current:false},branchInFlightRef:{current:false},session:{id:'s',summary:'current memory',summary_last_turn:25},profile:{summary_prompt:'custom core'},
  messages:complete.slice(-5),sendInFlightRef:{current:false},summaryGenerating:false,
  activeGenerations:new Map(),activeSummaryGenerations:new Map(),AbortController,
  getApiKey:()=> 'mock-key',registerAccountTask:()=>()=>{},
  setSummaryGenerating:()=>{},finishSummaryGeneration:()=>{},setMessages:()=>{},setSession:()=>{},
  readLiveThemeContext:async()=>({session:{theme_override:'builtin'},names:[]}),
  fetchAllSessionMessages:async()=>complete,stripThemeDirectives:text=>text,
  modelsFor:()=>['mock-model'],normalizeReasoning:()=>({send:false}),
  generate:async(_provider,args)=>{summaryRequests.push(args);return {text:'merged memory',usage:{inputTokens:1,outputTokens:2,cost:0}};},
  supabase:{rpc:async(name,args)=>{commits.push({name,args});return {data:{id:'s'},error:null};}},
  addError:message=>summaryErrors.push(message),describeUnknownError:error=>error.message,
});
await merging([
  {id:'note10',content:'memory through ten',summarized_through_turn:10},
  {id:'note20',content:'memory through twenty',summarized_through_turn:20},
],20);
assert.deepEqual(summaryErrors,[]);
assert.equal(commits[0]?.args.through_turn,20,'summary merge must not replace the checkpoint with the viewport count');
assert.ok(summaryRequests[0].messages[0].content.includes('memory through twenty'));
assert.equal(commits[0].args.source_versions[1].id,'note20');
console.log('Integrity client: bounded draft writes, account cancellation without screen listeners, keyword boundary, summary conflict guard and merge checkpoint passed');
