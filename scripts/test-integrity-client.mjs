import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const uri=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {withoutSyncDateTags}=await import(uri(compile(readFileSync(new URL('../src/lib/syncDate.ts',import.meta.url),'utf8'))));
const themeURL=uri(compile(readFileSync(new URL('../src/lib/theme.ts',import.meta.url),'utf8')));
const {automaticThemeEnabled,normalizeThemePeriods,stripThemeDirectives}=await import(uri(compile(
  readFileSync(new URL('../src/lib/themeDirectives.ts',import.meta.url),'utf8').replace("'./theme'",JSON.stringify(themeURL)))));
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
const summaryPromptWithParameters=vm.runInNewContext(compile(readFileSync(new URL('../src/lib/summaryPrompt.ts',import.meta.url),'utf8')
  .replace(/^import .*$/gm,'').replace(/\bexport /g,''))+'\nsummaryPromptWithParameters');
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
let summaryThemeContext={session:{theme_override:'builtin'},themes:[],names:[],dayNight:false};
let summaryConnected=false;
const summaryTasks=new Map();
const sharedActions=[];let summaryMessageWrites=0;
const merging=vm.runInNewContext(fn('messagesThroughTurn')+'\n'+fn('generateSummary')+'\ngenerateSummary',{
  contextReady:true,editInFlightRef:{current:false},deleteInFlightRef:{current:false},branchInFlightRef:{current:false},session:{id:'s',summary:'current memory',summary_last_turn:25},profile:{summary_prompt:'IGNORED PRIVATE',summary_level:0,summary_allow_omission:false,summary_extra_note:'EXTRA MEMORY NOTE'},summaryPromptWithParameters,withoutSyncDateTags,loadSemiContext:async()=>summaryConnected?{}:null,loadGlobalSummaryPrompt:async()=> 'global summary core',loadSemiSyncSummaryPrompt:async()=> 'sync summary core',
  messages:complete.slice(-5),sendInFlightRef:{current:false},summaryGenerating:false,
  activeGenerations:new Map(),activeSummaryGenerations:summaryTasks,workCombinationSavingRef:{current:false},AbortController,
  getApiKey:()=> 'mock-key',registerAccountTask:()=>()=>{},
  setSummaryGenerating:()=>{},finishSummaryGeneration:id=>summaryTasks.delete(id),setMessages:()=>summaryMessageWrites++,setSession:()=>{},
  semiAction:async(operation,sessionId,linkId,details)=>{sharedActions.push({operation,details});return operation==='prepare'?{token:'share-token',session:{id:'s',summary:'current memory',summary_last_turn:25,summary_source_mode_override:'full'},persona:{name:'SOURCE NAME',description:'SOURCE DESCRIPTION'}}:{total_cost:0.01};},
  readLiveThemeContext:async()=>summaryThemeContext, recoverExpiredResponses:async()=>0,
  fetchAllSessionMessages:async()=>complete,automaticThemeEnabled,normalizeThemePeriods,stripThemeDirectives,
  modelsFor:()=>['mock-model'],normalizeReasoning:()=>({send:false}),
  generate:async(_provider,args)=>{summaryRequests.push(args);return {text:'merged memory',usage:{inputTokens:1,outputTokens:2,cost:0}};},
  supabase:{rpc:async(name,args)=>{commits.push({name,args});return {data:{id:'s'},error:null};}},
  addError:message=>summaryErrors.push(message),describeUnknownError:error=>error.message,
});
await merging([
  {id:'note10',content:'memory through ten',summarized_through_turn:10},
  {id:'note20',content:'memory through twenty',summarized_through_turn:20},
],20);
const expectedCore='global summary core\n\n[SUMMARY CONFIGURATION]\nSUMMARY_LEVEL = 0\nALLOW_OMISSION = OFF\n\n[ADDITIONAL NOTE]\nEXTRA MEMORY NOTE';
assert.deepEqual(summaryErrors,[]);assert.equal(summaryRequests[0].systemParts.core,expectedCore);
assert.equal(commits[0]?.args.through_turn,20,'summary merge must not replace the checkpoint with the viewport count');
assert.ok(summaryRequests[0].messages[0].content.includes('memory through twenty'));
assert.equal(commits[0].args.source_versions[1].id,'note20');
for(const count of [0,1,2]){
  summaryThemeContext={session:{theme_override:null},themes:Array.from({length:count},(_,i)=>({id:'theme'+i,name:'scene'+i,work_id:'work'})),names:[],dayNight:false};
  const notes=[{id:'tagged',content:'memory {{theme::scene0}}',summarized_through_turn:20}];
  const snapshot=JSON.stringify(notes);
  await merging(notes,20);
  assert.deepEqual(summaryErrors,[]);assert.equal(summaryRequests.at(-1).systemParts.core,expectedCore);
  assert.equal(summaryRequests.at(-1).messages[0].content.includes('{{theme::'),count>1,'actual summary request must use the same theme-count gate');
  assert.equal(JSON.stringify(notes),snapshot);
}
console.log('Integrity client: bounded draft writes, account cancellation without screen listeners, keyword boundary, summary conflict guard and merge checkpoint passed');

const beforeShareCommits=commits.length,beforeShareWrites=summaryMessageWrites;
assert.equal(await merging([],undefined,'peer-link'),true);
assert.deepEqual(sharedActions.map(action=>action.operation),['prepare','publish']);
assert.equal(sharedActions[1].details.content,'merged memory');
assert.equal(commits.length,beforeShareCommits,'export must not save a local summary version');
assert.equal(summaryMessageWrites,beforeShareWrites,'export must not mark messages summarized');
assert.equal(summaryRequests.at(-1).systemParts.core,'sync summary core');
assert.ok(summaryRequests.at(-1).systemParts.persona.includes('SOURCE NAME'));assert.ok(summaryRequests.at(-1).systemParts.persona.includes('SOURCE DESCRIPTION'));
assert.equal(summaryRequests.at(-1).systemParts.summary,'','no peer context is passed to the summary model');
console.log('Real summary export: independent sync prompt, captured source persona, existing model/input path, separate publish, no local summary or message mutation passed');

const originalRequest={systemParts:{core:'C{{sync_date::date}}',persona:'P',userNote:'N',summary:'S{{sync_date::old}}',keywords:'K'},messages:[{role:'assistant',content:'A{{sync_date::date}}',cacheBreakpoint:true},{role:'user',content:'U'}]};
const originalJSON=JSON.stringify(originalRequest),clean=withoutSyncDateTags(originalRequest);
assert.equal(clean.systemParts.core,'C');assert.equal(clean.systemParts.summary,'S');assert.equal(clean.messages[0].content,'A');assert.equal(clean.messages[0].cacheBreakpoint,true);assert.equal(JSON.stringify(originalRequest),originalJSON);
assert.equal(withoutSyncDateTags({...originalRequest,messages:[{role:'assistant',content:'A{{sync_date::partial'}]}).messages[0].content,'A');
const tagged=[{id:'tagged-date',content:'memory {{sync_date::1889년}}',summarized_through_turn:20}];
summaryConnected=false;await merging(tagged,20);assert.ok(!summaryRequests.at(-1).messages[0].content.includes('{{sync_date::'));
summaryConnected=true;await merging(tagged,20);assert.ok(summaryRequests.at(-1).messages[0].content.includes('{{sync_date::'));
assert.equal(tagged[0].content,'memory {{sync_date::1889년}}');
console.log('Disconnected dates: full request sanitation, incomplete tags, cache marker, immutable sources and connected/disconnected real summary paths passed');
