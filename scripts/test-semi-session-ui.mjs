import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
const uri=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const hooks=uri(`export const useEffect=()=>{};export function useState(initial){const h=globalThis.__semiUI,i=h.index++;if(!(i in h.values))h.values[i]=typeof initial==='function'?initial():initial;return[h.values[i],next=>h.values[i]=typeof next==='function'?next(h.values[i]):next]};export function useRef(initial){const h=globalThis.__semiUI,i=h.index++;return h.values[i]??=( {current:initial} )}`);
const imports={react:hooks,'@/lib/supabase':uri('export const supabase={};'),
 '@/lib/friends':uri('export const loadFriendSnapshot=async()=>({snapshot:{relationships:[]}});'),
 '@/lib/semiSession':uri('export const loadSemiLinks=async()=>[];export const semiAction=(...args)=>globalThis.__semiAction(...args);'),
 './InterfaceIcon':uri('export default ()=>null;')};
const compile=ts.transpileModule(readFileSync(new URL('../src/components/SemiSessionSettings.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const Component=(await import(uri(compile.replace(/from\s+(['"])([^'"]+)\1/g,(_,q,path)=>'from '+JSON.stringify(imports[path]??import.meta.resolve(path)))))).default;
const snapshot={persona:{name:'레온',description:'MERCHANT'},content:'PEER MEMORY',sent_at:'2026-10-28T10:00:00Z'};
const active={id:'link',user_a:'a',user_b:'b',session_a:'sa',session_b:'sb',title_a:'A',title_b:'B',status:'active',snapshot_a:{...snapshot,content:'OWN EXPORT'},snapshot_b:snapshot};
const calls=[],saves=[];let published=0;
globalThis.__semiAction=async(...args)=>{calls.push(args);return {};};
globalThis.__semiUI={index:0,values:[[active],[{user_id:'b',display_name:'친구'}],true,false,'','','',0]};
let props={sessionId:'sa',userId:'a',busy:false,onPublish:async()=>{published++;return true;},onSavingChange:value=>{saves.push(value);return true;}};
const render=()=>{globalThis.__semiUI.index=0;return Component(props);};
function nodes(n,p,out=[]){if(!n||typeof n!=='object')return out;if(p(n))out.push(n);for(const c of [n.props?.children].flat(Infinity))nodes(c,p,out);return out;}
const button=(tree,text)=>nodes(tree,n=>n.type==='button'&&n.props.children===text)[0];
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
let tree=render(),markup=renderToStaticMarkup(tree);
assert.ok(markup.includes('PEER MEMORY'));assert.ok(markup.includes('레온'));assert.ok(!markup.includes('OWN EXPORT'),'own export is not displayed as peer memory');
const publish=button(tree,'요약 생성하여 동기화');publish.props.onClick();publish.props.onClick();await tick();assert.equal(published,1,'double-click requests only one generation');
tree=render();assert.ok(renderToStaticMarkup(tree).includes('내 요약 노트는 유지'));
button(tree,'연결 해제').props.onClick();await tick();assert.deepEqual(calls.at(-1).slice(0,3),['close','sa','link']);assert.deepEqual(saves,[true,false]);
globalThis.__semiUI.values[0]=[];tree=render();nodes(tree,n=>n.type==='select')[0].props.onChange({target:{value:'b'}});tree=render();button(tree,'연결 요청').props.onClick();await tick();assert.deepEqual(calls.at(-1),['request','sa',undefined,undefined,'b']);
props={...props,userId:'b',sessionId:'sb'};globalThis.__semiUI.values[0]=[{...active,status:'pending',session_b:null,snapshot_a:null,snapshot_b:null}];tree=render();button(tree,'이 채팅방과 연결').props.onClick();await tick();assert.deepEqual(calls.at(-1).slice(0,3),['accept','sb','link'],'recipient chooses their own session');
props={...props,busy:true,userId:'a',sessionId:'sa'};globalThis.__semiUI.values[0]=[active];tree=render();assert.equal(button(tree,'처리 중…').props.disabled,true);
console.log('Semi session real JSX: peer-only preview, publish/double-click lock, busy state, owner-session acceptance, request and unlink actions passed');
