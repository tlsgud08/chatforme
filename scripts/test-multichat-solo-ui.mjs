import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
const uri=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const compile=path=>ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const hooks=uri(`export const useEffect=f=>{globalThis.__solo.effects.push(f)};
export const useRef=v=>{const s=globalThis.__solo,i=s.index++;return s.values[i]??=( {current:v} )};
export const useState=v=>{const s=globalThis.__solo,i=s.index++;if(!(i in s.values))s.values[i]=v;return[s.values[i],v=>s.values[i]=typeof v==='function'?v(s.values[i]):v]};`);
const db=uri('export const supabase=globalThis.__soloDb;');
const imports={react:hooks,'@/lib/supabase':db,'@/lib/dialog':uri('export const showConfirmDialog=(...a)=>globalThis.__soloConfirm(...a);'),'@/lib/toast':uri('export const showToast=t=>globalThis.__solo.toasts.push(t);'),'@/lib/multichat':uri('export const multichatParticipantName=(slot,members)=>members.find(m=>m.slot===slot).personas.name;'),'./InterfaceIcon':uri('export default ()=>null;')};
const module=path=>uri(compile(path).replace(/from\s+(['"])([^'"]+)\1/g,(_,q,p)=>'from '+JSON.stringify(imports[p]??import.meta.resolve(p))));
globalThis.__solo={index:0,values:[],effects:[],toasts:[]};
const calls=[],dialogs=[],updates=[];
let response={data:{progress_mode:'solo',solo_slot:2,progress_revision:8}},refreshes=0;
globalThis.__soloDb={rpc:async(name,args)=>{calls.push({name,args});return response;}};
globalThis.__soloConfirm=async(...args)=>{dialogs.push(args);return true;};
const Component=(await import(module('src/components/MultichatProgressSettings.tsx'))).default;
let props={room:{id:'room',progress_mode:'together',solo_slot:null,progress_revision:7},members:[{slot:1,personas:{name:'누리'}},{slot:2,personas:{name:'소희'}}],slot:2,otherPresent:true,presenceReady:true,onUpdate:r=>updates.push(r),onRefresh:async()=>{refreshes++;}};
const render=()=>{globalThis.__solo.index=0;return Component(props);};
function find(node,label){if(!node||typeof node!=='object')return null;if(node.type==='button'&&node.props.children===label)return node;for(const child of [node.props?.children].flat(Infinity)){const match=find(child,label);if(match)return match;}return null;}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
let tree=render();find(tree,'나 혼자 진행').props.onClick();find(tree,'나 혼자 진행').props.onClick();await tick();
assert.equal(dialogs.length,1);assert.ok(dialogs[0][1].includes('상대방도 이 채팅방'));assert.equal(calls.length,1);
assert.deepEqual(calls[0],{name:'set_multichat_progress',args:{target_room:'room',mode:'solo',expected_revision:7}});assert.equal(updates[0].solo_slot,2);
props={...props,room:{...props.room,progress_mode:'solo',solo_slot:2,progress_revision:8}};tree=render();assert.ok(renderToStaticMarkup(tree).includes('소희 혼자 진행 중'));assert.equal(find(tree,'나 혼자 진행').props.disabled,true);
find(tree,'함께 진행').props.onClick();await tick();assert.equal(dialogs.length,1);assert.equal(calls.at(-1).args.mode,'together');
// Cancelled warning does not write; unknown presence also asks before writing.
props={...props,room:{...props.room,progress_mode:'together',solo_slot:null}};globalThis.__soloConfirm=async(...args)=>{dialogs.push(args);return false;};
const before=calls.length;find(render(),'나 혼자 진행').props.onClick();await tick();assert.equal(calls.length,before);
props={...props,otherPresent:false,presenceReady:false};find(render(),'나 혼자 진행').props.onClick();await tick();assert.ok(dialogs.at(-1)[1].includes('확인하지 못했어요'));assert.equal(calls.length,before);
// The revision is captured before the confirmation. A concurrent mode update
// must cause a refresh, not silently overwrite the newer selection.
let confirm;
globalThis.__soloConfirm=()=>new Promise(resolve=>{confirm=resolve;});
props={...props,otherPresent:true,presenceReady:true,room:{...props.room,progress_revision:9}};
find(render(),'나 혼자 진행').props.onClick();props={...props,room:{...props.room,progress_revision:10}};render();
response={data:null,error:{message:'다른 참여자가 진행 방식을 변경했습니다.'}};confirm(true);await tick();
assert.equal(calls.at(-1).args.expected_revision,9);assert.equal(refreshes,1);assert.ok(globalThis.__solo.toasts.at(-1).includes('다른 참여자'));
// Known absent peer needs no warning; PC1 can use the same controls as PC2.
props={...props,slot:1,otherPresent:false,presenceReady:true};response={data:{progress_mode:'solo',solo_slot:1}};const count=dialogs.length;
find(render(),'나 혼자 진행').props.onClick();await tick();assert.equal(dialogs.length,count);assert.equal(updates.at(-1).solo_slot,1);
console.log('Solo UI: both roles, current persona, peer/unknown-presence warning, cancel, duplicate click, captured-revision conflict/refresh and shared-mode return passed');

// Exercise the actual presence hook: idle peers count as connected, editing
// drafts never enter presence, and old callbacks cannot affect a new room.
const channels=[];let release;
globalThis.__solo={index:0,values:[],effects:[],toasts:[]};
globalThis.__soloDb.channel=(topic)=>{const c={topic,state:{},track:async value=>{c.payload=value;},on(_,__,cb){c.sync=cb;return c;},presenceState(){return c.state;},subscribe(cb){c.status=cb;return c;}};channels.push(c);return c;};
globalThis.__soloDb.removeChannel=()=>new Promise(resolve=>{release=resolve;});
const {useMultichatEditing}=await import(module('src/hooks/useMultichatEditing.ts'));
const hook=(room='r1',editing=null)=>{globalThis.__solo.index=0;return useMultichatEditing(room,'self',editing);};
hook();const cleanup=globalThis.__solo.effects[0]();await tick();const first=channels[0];first.status('SUBSCRIBED');assert.deepEqual(first.payload,{user_id:'self',target:null});
first.state={one:[{user_id:'peer',target:null}],two:[{user_id:'peer',target:{kind:'assistant',id:'msg'}}]};first.sync();
let state=hook();assert.deepEqual(state.connectedUserIds,['peer']);assert.equal(state.others.length,1);assert.equal(state.presenceReady,true);
cleanup();await tick();first.sync();globalThis.__solo.effects=[];hook('r2');const cleanup2=globalThis.__solo.effects[0]();await tick();assert.equal(channels.length,1,'new presence waits for prior same-client teardown');
release();await tick();assert.equal(channels.length,2);channels[1].status('CHANNEL_ERROR');state=hook('r2');assert.equal(state.presenceReady,false);
cleanup2();await tick();release();await tick();
console.log('Room presence: idle peers, multiple tabs, editor IDs only, stale callbacks, serialized teardown and disconnected uncertainty passed');
