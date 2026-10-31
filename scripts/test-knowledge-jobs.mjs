import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const compile=s=>ts.transpileModule(s.replace(/^import .*$/gm,'').replace(/export default function/g,'function').replace(/export /g,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React,jsxFactory:'jsx'}}).outputText;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
let calls=0, resolveJob, rejectJob, liveSignal, progress, released=0;
const account=vm.runInNewContext(compile(read('src/lib/accountTasks.ts'))+'\n({registerAccountTask,subscribeAccountTaskReset,abortAccountTasks})');
const registry=vm.runInNewContext(compile(read('src/lib/knowledge/jobs.ts'))+'\n({getKnowledgeJob,startKnowledgeJob,stopKnowledgeJob,forgetKnowledgeJob,subscribeKnowledgeJobs})',{
  AbortController, CustomEvent:class{}, window:{dispatchEvent(){}},
  registerAccountTask:controller=>{const release=account.registerAccountTask(controller);return()=>{released++;release();}}, subscribeAccountTaskReset:account.subscribeAccountTaskReset,
  generateKnowledgeNow:(_id,_key,signal,onProgress)=>{calls++;liveSignal=signal;progress=onProgress;return new Promise((resolve,reject)=>{resolveJob=resolve;rejectJob=reject;signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')));});}
});
const props={session:{id:'room',knowledge_enabled:true,knowledge_revision:1},busy:false,onUpdate(){}};
let clearCalls=0, confirm=false;
function mount() {
  let values=[],refs=[],effects=[],i=0,r=0,e=0;
  const hooks={useState(initial){const n=i++;if(!(n in values))values[n]=typeof initial==='function'?initial():initial;return[values[n],v=>{values[n]=typeof v==='function'?v(values[n]):v}]},useRef(v){return refs[r++]??={current:v}},useMemo:fn=>fn(),useEffect(fn,deps){const n=e++;const old=effects[n];if(!old||deps.some((v,i)=>v!==old.deps[i])){old?.cleanup?.();effects[n]={deps,fn,pending:true};}}};
  const Panel=vm.runInNewContext(compile(read('src/components/SessionInformationSettings.tsx'))+'\nSessionInformationSettings',{
    ...hooks,...registry,jsx:createElement,getApiKey:()=> 'fixture',Toggle:'toggle',
    emptyState:()=>({actors:[],facts:[],knowledge:[],scene:[]}),replayContext:()=>({state:{actors:[],facts:[],knowledge:[],scene:[]},pending:[]}),knowledgeSymbol:()=> 'X',
    readKnowledgeContext:async()=>({entries:[],cost:0,inputTokens:0,outputTokens:0}),
    window:{addEventListener(){},removeEventListener(){}},showConfirmDialog:async()=>confirm,
    cancelKnowledge(){},supabase:{rpc:async()=>{clearCalls++;return{data:{knowledge_enabled:false,knowledge_revision:2}}}}
  });
  return {render(){i=r=e=0;const tree=Panel(props);for(const effect of effects)if(effect.pending){effect.pending=false;effect.cleanup=effect.fn();}return tree},unmount(){effects.forEach(effect=>effect.cleanup?.())}};
}
function nodes(n){return !n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).flatMap(nodes)]}
const button=(tree,label)=>{const found=nodes(tree).find(n=>n.type==='button'&&n.props.children===label);assert.ok(found,label);return found};
let screen=mount();let tree=screen.render();
button(tree,'지금 생성/갱신').props.onClick();button(tree,'지금 생성/갱신').props.onClick();assert.equal(calls,1);
tree=screen.render();assert.equal(button(tree,'정보 정리 중…').props.disabled,true);
progress(2,5);screen.unmount();assert.equal(liveSignal.aborted,false,'leaving the screen must not abort');
screen=mount();tree=screen.render();assert.equal(button(tree,'정보 정리 중…').props.disabled,true);
assert.ok(nodes(tree).some(n=>n.props?.children==='5개 중 2개 응답 정리 완료'),'returning restores progress');
resolveJob({processed:5});await tick();tree=screen.render();assert.ok(nodes(tree).some(n=>n.props?.children==='정보표 생성/갱신을 완료했어요.'));
screen.unmount();screen=mount();tree=screen.render();assert.ok(nodes(tree).some(n=>n.props?.children==='정보표 생성/갱신을 완료했어요.'),'completion while absent remains visible');
button(tree,'지금 생성/갱신').props.onClick();tree=screen.render();button(tree,'정보 정리 중단').props.onClick();assert.equal(liveSignal.aborted,true);await tick();tree=screen.render();assert.ok(nodes(tree).some(n=>String(n.props?.children).includes('정보 정리를 중단했어요.')));
button(tree,'지금 생성/갱신').props.onClick();rejectJob(new Error('fixture failure'));await tick();assert.equal(registry.getKnowledgeJob('room').status,'error');
await button(screen.render(),'정보표 전체 삭제').props.onClick();await tick();assert.equal(clearCalls,0);
confirm=true;button(screen.render(),'정보표 전체 삭제').props.onClick();button(screen.render(),'정보표 전체 삭제').props.onClick();await tick();assert.equal(clearCalls,1);assert.equal(registry.getKnowledgeJob('room'),null,'deletion removes stale completion messages');
registry.startKnowledgeJob('room','fixture');account.abortAccountTasks();assert.equal(liveSignal.aborted,true);resolveJob({processed:1});await tick();assert.equal(registry.getKnowledgeJob('room'),null,'account reset clears state and late results stay cleared');
assert.equal(released,4);screen.unmount();
console.log('Knowledge jobs: navigation/remount, progress restore, completion while absent, duplicate clicks, explicit stop, error, delete confirmation and account reset passed.');
