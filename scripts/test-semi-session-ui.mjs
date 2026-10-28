import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
const uri=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const hooks=uri(`export const useEffect=()=>{};export function useState(initial){const h=globalThis.__semiUI,i=h.index++;if(!(i in h.values))h.values[i]=typeof initial==='function'?initial():initial;return[h.values[i],next=>h.values[i]=typeof next==='function'?next(h.values[i]):next]};export function useRef(initial){const h=globalThis.__semiUI,i=h.index++;return h.values[i]??=( {current:initial} )}`);
const imports={react:hooks,'@/lib/supabase':uri('export const supabase={};'),
 '@/lib/friends':uri('export const loadFriendSnapshot=async()=>({snapshot:{relationships:[]}});'),
 '@/lib/semiSession':uri('export const editSemiExport=(...args)=>globalThis.__editSemiExport(...args);export const loadSemiContext=async()=>null;export const loadSemiLinks=async()=>[];export const semiAction=(...args)=>globalThis.__semiAction(...args);'),
 './SessionMenuFrame':uri('import {createElement} from '+JSON.stringify(import.meta.resolve('react'))+';export const SessionMenuPage=({children})=>createElement("section",null,children);'),
 './InterfaceIcon':uri('export default ()=>null;')};
const compile=ts.transpileModule(readFileSync(new URL('../src/components/SemiSessionSettings.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const Component=(await import(uri(compile.replace(/from\s+(['"])([^'"]+)\1/g,(_,q,path)=>'from '+JSON.stringify(imports[path]??import.meta.resolve(path)))))).default;
const snapshot={persona:{name:'레온',description:'MERCHANT'},content:'PEER MEMORY',sent_at:'2026-10-28T10:00:00Z'};
const active={id:'link',user_a:'a',user_b:'b',session_a:'sa',session_b:'sb',title_a:'A',title_b:'B',status:'active',sync_date_a:'MY DATE',sync_date_b:'PEER DATE',snapshot_a:{...snapshot,content:'OWN EXPORT'},snapshot_b:snapshot};
const calls=[],saves=[];let published=0;
globalThis.__semiAction=async(...args)=>{calls.push(args);return {};};
globalThis.__semiUI={index:0,values:[[active],[{user_id:'b',display_name:'친구'}],true,false,'','','',0]};
let props={sessionId:'sa',userId:'a',busy:false,onPublish:async()=>{published++;return true;},onSavingChange:value=>{saves.push(value);return true;}};
const render=()=>{globalThis.__semiUI.index=0;return Component(props);};
function nodes(n,p,out=[]){if(!n||typeof n!=='object')return out;if(p(n))out.push(n);for(const c of [n.props?.children].flat(Infinity))nodes(c,p,out);return out;}
const button=(tree,text)=>nodes(tree,n=>n.type==='button'&&n.props.children===text)[0];
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
let tree=render(),markup=renderToStaticMarkup(tree);
assert.ok(markup.includes('PEER DATE'));assert.ok(!markup.includes('MY DATE'));assert.ok(markup.includes('레온'));assert.ok(!markup.includes('OWN EXPORT'));
button(tree,'연동 정보 열람').props.onClick();tree=render();markup=renderToStaticMarkup(tree);assert.ok(markup.includes('PEER MEMORY'));assert.ok(markup.includes('OWN EXPORT'));assert.ok(markup.includes('받은 PC2 세션 요약'));assert.ok(markup.includes('내가 보낸 페르소나·요약'));
let editedExport=null;globalThis.__editSemiExport=async(...args)=>{editedExport=args;return{...snapshot,content:args[3],persona:{name:args[4],description:args[5]}};};
button(tree,'내 전송 내용 편집').props.onClick();tree=render();nodes(tree,n=>n.props?.id==='semi-export-summary')[0].props.onChange({target:{value:'EDITED EXPORT'}});tree=render();button(tree,'전송 내용 저장').props.onClick();await tick();assert.equal(editedExport[0],'sa');assert.equal(editedExport[3],'EDITED EXPORT');assert.equal(editedExport[2].content,'OWN EXPORT');saves.length=0;
const publish=button(tree,'요약 생성하여 동기화');publish.props.onClick();publish.props.onClick();await tick();assert.equal(published,1,'double-click requests only one generation');
tree=render();assert.ok(renderToStaticMarkup(tree).includes('내 요약 노트는 유지'));
button(tree,'연결 해제').props.onClick();await tick();assert.deepEqual(calls.at(-1).slice(0,3),['close','sa','link']);assert.deepEqual(saves,[true,false]);
globalThis.__semiUI.values[0]=[];tree=render();nodes(tree,n=>n.type==='select')[0].props.onChange({target:{value:'b'}});tree=render();button(tree,'연결 요청').props.onClick();await tick();assert.deepEqual(calls.at(-1),['request','sa',undefined,undefined,'b']);
props={...props,userId:'b',sessionId:'sb'};globalThis.__semiUI.values[0]=[{...active,status:'pending',session_b:null,snapshot_a:null,snapshot_b:null}];tree=render();button(tree,'이 채팅방과 연결').props.onClick();await tick();assert.deepEqual(calls.at(-1).slice(0,3),['accept','sb','link'],'recipient chooses their own session');
props={...props,busy:true,userId:'a',sessionId:'sa'};globalThis.__semiUI.values[0]=[active];tree=render();assert.equal(button(tree,'처리 중…').props.disabled,true);
console.log('Semi session real JSX: peer-only preview, publish/double-click lock, busy state, owner-session acceptance, request and unlink actions passed');

props={...props,busy:false};globalThis.__semiUI.values[10]={prompt:'RULES',peer_persona:{name:'현재 레온',description:'CURRENT LIVE PERSONA'},peer:null};globalThis.__semiUI.values[0]=[{...active,snapshot_b:null}];tree=render();markup=renderToStaticMarkup(tree);assert.ok(markup.includes('CURRENT LIVE PERSONA'));assert.ok(markup.includes('아직 전달용 요약을 보내지'));assert.ok(!markup.includes('PEER MEMORY'));console.log('Semi sidebar: current PC2 persona is visible before summary generation passed');

// The two administrator editors load drafts locally and save to distinct fields.
const adminCalls=[];
globalThis.__semiAdminDb={rpc:async(name,args)=>{adminCalls.push({name,args});return{data:true,error:null};}};
const contextDraft=readFileSync(new URL('../src/lib/prompts/semi-multichat.md',import.meta.url),'utf8');
const syncDraft=readFileSync(new URL('../src/lib/prompts/semi-sync-summary.md',import.meta.url),'utf8');
const adminImports={react:hooks,'@/lib/supabase':uri('export const supabase=globalThis.__semiAdminDb;'),
 '@/lib/prompts/semi-multichat.md?raw':uri('export default '+JSON.stringify(contextDraft)),
 '@/lib/prompts/semi-sync-summary.md?raw':uri('export default '+JSON.stringify(syncDraft))};
const adminSource=ts.transpileModule(readFileSync(new URL('../src/components/SemiMultichatPromptSettings.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const {SemiPromptEditor}=(await import(uri(adminSource.replace(/from\s+(['"])([^'"]+)\1/g,(_,q,path)=>'from '+JSON.stringify(adminImports[path]??import.meta.resolve(path))))));
for(const [kind,label,draft,rpc] of [['context','연동 규약 초안 불러오기',contextDraft,'save_semi_multichat_prompt'],['sync','동기화 요약 초안 불러오기',syncDraft,'save_semi_sync_summary_prompt']]){
 globalThis.__semiUI={index:0,values:['ADMIN ORIGINAL',true,false,'',0,{current:'ADMIN ORIGINAL'},{current:false}]};
 const adminRender=()=>{globalThis.__semiUI.index=0;return SemiPromptEditor({kind});};
 let admin=adminRender(),prior=adminCalls.length;button(admin,label).props.onClick();admin=adminRender();
 assert.equal(nodes(admin,n=>n.type==='textarea')[0].props.value,draft);assert.equal(adminCalls.length,prior,'loading a draft must not overwrite global settings');
 nodes(admin,n=>n.type==='button'&&typeof n.props.children==='string'&&n.props.children.endsWith(' 저장'))[0].props.onClick();await tick();
 assert.deepEqual(adminCalls.at(-1),{name:rpc,args:{previous:'ADMIN ORIGINAL',desired:draft}});
}
console.log('Semi admin editors: isolated context/sync fields and explicit draft-save passed');
