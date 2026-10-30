import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
const originalFetch=globalThis.fetch;
globalThis.window={location:{origin:'https://knowledge.test'}};
try {
  const {supabase}=await server.ssrLoadModule('/src/lib/supabase.ts');
  const {DEFAULT_KNOWLEDGE_CONFIG:config}=await server.ssrLoadModule('/src/lib/knowledge/types.ts');
  const {applyKnowledge,applyPatch,emptyState,knowledgeBlock}=await server.ssrLoadModule('/src/lib/knowledge/core.ts');
  const {prepareKnowledge,replayContext,queueKnowledge,cancelKnowledge}=await server.ssrLoadModule('/src/lib/knowledge/runtime.ts');
  const {finalThemeDirective,observeThemeDirective,resolveThemeDirectiveChoice}=await server.ssrLoadModule('/src/lib/themeDirectives.ts');
  const base=Object.freeze({systemParts:Object.freeze({core:'unchanged',persona:'p',summary:'s',userNote:'n',keywords:'k'}),messages:Object.freeze([{role:'user',content:'action',cacheBreakpoint:true}])});
  assert.equal(applyKnowledge(base,false),base,'OFF is the same object');
  const patch={actors:[{name:'PC',pc:true,aliases:[]},{name:'A',pc:false,aliases:[]}],facts:[{id:'f',text:'PC는 요원이다',kind:'pc',secret:true,subjects:['PC']}],knowledge:[{fact:'f',actor:'PC',status:'knows',reason:'본인 신분',quote:'요원',source:'seed'},{fact:'f',actor:'A',status:'believes',reason:'PC를 회사원으로 오해함: 위조 명함을 봄',quote:'위조 명함',source:'1'}],scene:['A']};
  const state=applyPatch(emptyState(),patch),on=applyKnowledge(base,true,config,state);
  assert.equal(on.messages,base.messages);assert.equal(on.systemParts.core,base.systemParts.core);
  assert.match(on.systemParts.keywords,/△: PC를 회사원으로 오해함/);assert.match(on.systemParts.keywords,/O: 본인 신분/);
  assert.ok(on.systemParts.keywords.includes(config.mainPrompt));
  const unknown=applyPatch(state,{...emptyState(),knowledge:[{...patch.knowledge[0],status:'unknown'}]});
  assert.match(knowledgeBlock(unknown),/\| X \|/,'manual X can replace O');assert.equal(unknown.actors.length,2,'leaving a scene never deletes actors');
  const themes=[{id:'1',name:'정원',work_id:'w'},{id:'2',name:'실내',work_id:'w'}];
  const valid=name=>name==='keep'||!!resolveThemeDirectiveChoice(name,themes);
  assert.equal(finalThemeDirective('{{theme::정원}} 본문'),null);
  assert.equal(finalThemeDirective('{{theme::정원}} 본문',true,valid),'정원');
  assert.equal(finalThemeDirective('{{theme::정원}} 본문 {{theme::없는테마}}',true,valid),'정원');
  assert.equal(finalThemeDirective('{{theme::정원}} {{theme::keep}} 뒤 본문',true,valid),'keep');
  const old=observeThemeDirective(null,'s',{id:'m',content:'{{theme::정원}} 본문'},false).observation;
  assert.equal(observeThemeDirective(old,'s',{id:'m',content:'{{theme::정원}} 본문'},true).changed,false,'enabling does not replay an old tag');
  assert.equal(observeThemeDirective({...old,anywhere:true},'s',{id:'new',content:'{{theme::정원}} 본문'},true).changed,true);
  let context={enabled:true,revision:1,cost:0,inputTokens:0,outputTokens:0,entries:[{id:'session',turn_index:-1,content:'',user_text:'',content_version:0,source_hash:'seed',setup_hash:'',patch:null},{id:'m1',turn_index:1,content:'A와 PC가 도서관에서 만났다.',user_text:'도서관에 간다.',content_version:0,source_hash:'hash1',setup_hash:'',patch:null}]};
  const calls=[],decisions=[],bills=[];let gateProbability=0.95;
  supabase.from=()=>({select(){return this},eq(){return this},abortSignal(){return this},async single(){return {data:{knowledge_config:config},error:null}}});
  supabase.rpc=(name,args)=>{
    let result;
    if(name==='knowledge_lease') result={data:true,error:null};
    else if(name==='knowledge_context') result={data:structuredClone(context),error:null};
    else if(name==='record_knowledge_call'){bills.push(args);result={error:null};}
    else if(name==='save_knowledge_event'){
      const entry=context.entries.find(e=>e.id===args.target_message);assert.equal(args.expected_hash,entry.source_hash);
      entry.patch=args.desired;entry.setup_hash=args.setup_hash;result={data:true,error:null};
    }else throw Error('unexpected RPC '+name);
    const promise=Promise.resolve(result);promise.abortSignal=()=>promise;return promise;
  };
  globalThis.fetch=async(_url,options)=>{
    const request=JSON.parse(options.body);
    if(String(_url).endsWith('/decisions')) {
      decisions.push(request);
      assert.equal(request.model,'typesafe/jev-1.14');
      assert.equal(request.state.reference_setup,undefined,'detector never receives the work setup');
      assert.equal(request.state.knowledge,undefined,'detector never receives the full knowledge matrix');
      return new Response(JSON.stringify({answers:{update:{type:'noul',noul:gateProbability}},usage:{input_tokens:100,output_tokens:1,cost:0.0000042}}),{headers:{'content-type':'application/json'}});
    }
    calls.push(request);
    const input=JSON.parse(request.messages[1].content);
    const output=input.sources.setup ? {actors:[],facts:[{key:'N1',kind:'pc',text:'PC는 요원이다',secret:true,subjects:['PC'],source:'setup',quote:'PC는 요원이다'}],knowledge:[{fact:'N1',actor:'PC',status:'knows',reason:'본인 신분',source:'setup',quote:'PC는 요원이다',informer:''}],scene:[]} : {
      actors:[{name:'A',aliases:[],pc:false,quote:'A와 PC가 도서관에서 만났다.'},{name:'발명인물',aliases:[],pc:false,quote:'존재하지 않는 문장'}],
      facts:[{key:'N1',kind:'event',text:'PC와 A가 도서관에서 만났다',secret:false,subjects:['PC','A'],source:'assistant',quote:'A와 PC가 도서관에서 만났다.'},{key:'N2',kind:'event',text:'창고를 폭파했다',secret:false,subjects:['PC'],source:'assistant',quote:'발명한 폭발'}],
      knowledge:[{fact:'N1',actor:'A',status:'knows',reason:'직접 조우',source:'assistant',quote:'A와 PC가 도서관에서 만났다.',informer:''},{fact:'F1',actor:'A',status:'knows',reason:'억지 근거',source:'assistant',quote:'존재하지 않는 폭로',informer:''}],scene:['PC','A']};
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:30,cost:0.001}}),{headers:{'content-type':'application/json'}});
  };
  const opts={sessionId:'session',revision:1,apiKey:'fixture',signal:new AbortController().signal,setup:'PC는 요원이다',pcs:[{name:'PC',aliases:[],pc:true}]};
  const prepared=await prepareKnowledge(opts);
  assert.equal(calls.length,2,'one setup bootstrap and one new response');
  assert.equal(prepared.state.facts.length,2,'unquoted invented fact rejected');
  assert.equal(prepared.state.actors.length,2,'unencountered fabricated actor rejected');
  assert.equal(prepared.state.knowledge.some(k=>k.actor==='A'&&k.fact===prepared.state.facts[0].id),false,'unsupported secret knowledge rejected');
  assert.equal(bills.length,3);assert.equal(decisions.length,1);assert.equal(calls[0].model,'~deepseek/deepseek-flash-latest');
  await prepareKnowledge(opts);assert.equal(calls.length,2,'unchanged messages never repeat paid extraction');
  context.entries.push({...context.entries[1],id:'m2',turn_index:2,source_hash:'hash2',patch:null});
  await prepareKnowledge(opts);assert.equal(calls.length,3,'only messages since the checkpoint are sent');
  assert.equal(JSON.parse(calls.at(-1).messages[1].content).sources.assistant,'A와 PC가 도서관에서 만났다.');
  gateProbability=0.02;
  context.entries.push({...context.entries[1],id:'smalltalk',turn_index:3,source_hash:'hash3',content:'그는 가볍게 웃었다.',patch:null});
  const skipped=await prepareKnowledge(opts);
  assert.equal(calls.length,3,'a confident no-change decision skips the expensive recorder');
  assert.ok(context.entries.at(-1).patch,'a no-change checkpoint is persisted');
  assert.equal(skipped.state.facts.length,prepared.state.facts.length);
  assert.equal(skipped.state.actors.length,prepared.state.actors.length,'skipped turns preserve registered actors');
  const paidChecks=decisions.length;await prepareKnowledge(opts);assert.equal(decisions.length,paidChecks,'no-change checkpoints are not checked again');
  gateProbability=0.4;
  context.entries.push({...context.entries[1],id:'uncertain',turn_index:4,source_hash:'hash4',patch:null});
  await prepareKnowledge(opts);assert.equal(calls.length,4,'ambiguous decisions record conservatively');
  const recordInput=JSON.parse(calls.at(-1).messages[1].content);
  assert.equal(recordInput.reference_setup,undefined,'the recorder no longer repeats the complete work setup');
  assert.equal(recordInput.existing[0].quote,'PC는 요원이다','stored evidence is reused instead');
  const {needsKnowledgeUpdate}=await server.ssrLoadModule('/src/lib/knowledge/model.ts');
  const modelOptions={apiKey:'fixture',sessionId:'session',model:config.detectorModel,signal:opts.signal};
  gateProbability=null;assert.equal(await needsKnowledgeUpdate(modelOptions,'detect',{}),true,'malformed decisions never drop information');
  const mockFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new TypeError('detector unavailable')};
  assert.equal(await needsKnowledgeUpdate(modelOptions,'detect',{}),true,'outage falls back to recording');
  assert.equal(await needsKnowledgeUpdate(modelOptions,'detect',{text:'가'.repeat(12000)}),true,'long source bypasses the detector without truncation');
  globalThis.fetch=mockFetch;
  context.entries[1].patch=null;
  assert.equal(replayContext(context).pending.length,4,'stale entries invalidate dependent patches');
  context.enabled=false;await assert.rejects(()=>prepareKnowledge(opts),/설정/);assert.equal(calls.length,4);
  context.enabled=true;
  let startPaid;const paidStarted=new Promise(resolve=>startPaid=resolve);
  globalThis.fetch=async(_url,options)=>new Promise((_resolve,reject)=>{ startPaid();options.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}); });
  const firstJob=queueKnowledge(opts),sameJob=queueKnowledge(opts);
  assert.equal(firstJob,sameJob,'same-tab background calls are deduplicated');
  await paidStarted;cancelKnowledge('session');await firstJob;
  assert.equal(context.entries[1].patch,null,'cancelled background calls cannot publish a partial patch');
  console.log('Information runtime: full matrix with triangle reasons, OFF object identity, latest alias, evidence rejection, incremental paid calls, Jev skip/ambiguity/failure handling, evidence reuse, billing, causal replay and theme position rules verified.');
} finally {globalThis.fetch=originalFetch;await server.close();}
