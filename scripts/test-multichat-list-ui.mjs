import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
const uri=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const compile=path=>ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const hooks=uri(`export const useEffect=()=>{};export function useState(v){const s=globalThis.__listTest,i=s.index++;if(!(i in s.values))s.values[i]=typeof v==='function'?v():v;return[s.values[i],n=>s.values[i]=typeof n==='function'?n(s.values[i]):n]}`);
const empty=uri('export default ()=>null;export const FriendActivityStrip=()=>null;');
const calls=[],invalidated=[];
globalThis.__listTest={index:0,values:[]};globalThis.__listUser='guest';
globalThis.__listDb={rpc:async(name,args)=>{calls.push({name,args});return{data:null,error:null};},from(table){return{update(value){calls.push({table,value});return{eq:async()=>({error:null})};}};}};
const room={id:'room',host_user_id:'host',title:'멀티챗',status:'active',current_round:5,works:{title:'작품'},multichat_members:[{user_id:'host',slot:1},{user_id:'guest',slot:2}]};
const imports={react:hooks,'@/components/InterfaceIcon':empty,'@/components/ModernPageHeading':empty,'@/components/Friends':empty,'@/components/ConfirmDialog':empty,
 '@tanstack/react-query':uri('export const useQueryClient=()=>({invalidateQueries:async args=>globalThis.__invalidate(args)});export const useQuery=args=>({data:args.queryKey[0]===\'multichats\'?globalThis.__rooms:args.queryKey[0]===\'sessions\'?[{id:\'solo\',title:\'개인방\',works:{title:\'작품\'}}]:{},isLoading:false,isError:false});'),
 'react-router-dom':uri(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))};export const Link=({to,children,...props})=>createElement('a',{href:to,...props},children);export const useSearchParams=()=>[new URLSearchParams('tab=multichat')];`),
 '@/lib/supabase':uri('export const supabase=globalThis.__listDb;'),'@/lib/sessionCounts':uri('export const fetchSessionConversationCounts=()=>({});export const sessionCountsKey=()=>[\'counts\'];'),
 '@/lib/operationTiming':uri('export const measureOperation=(_,f)=>f();'),'@/hooks/useAuth':uri('export const useAuth=()=>({user:{id:globalThis.__listUser}});'),
 '@/lib/toast':uri('export const showToast=()=>{};'),'@/lib/dialog':uri('export const showConfirmDialog=async()=>false;')};
globalThis.__invalidate=args=>invalidated.push(args);globalThis.__rooms=[room];
const source=compile('src/pages/SessionsPage.tsx').replace(/from\s+(['"])([^'"]+)\1/g,(_,q,p)=>'from '+JSON.stringify(imports[p]??import.meta.resolve(p)));
const Page=(await import(uri(source))).default;
const render=()=>{globalThis.__listTest.index=0;return Page();};
function nodes(n,predicate,out=[]){if(!n||typeof n!=='object')return out;if(predicate(n))out.push(n);for(const c of [n.props?.children].flat(Infinity))nodes(c,predicate,out);return out;}
let tree=render();let row=nodes(tree,n=>n.type==='li'&&n.key==='room')[0];assert.ok(row);
assert.ok(nodes(row,n=>n.props?.to==='/multichat/room').length===1);assert.equal(nodes(row,n=>n.type==='button'&&n.props.children==='열기').length,0);
const menu=nodes(row,n=>n.type==='button'&&n.props['aria-label']==='멀티챗 메뉴')[0];assert.ok(menu);assert.equal(nodes(row,n=>n.props?.to&&nodes(n,c=>c===menu).length).length,0,'menu is outside navigation link');
menu.props.onClick();tree=render();assert.equal(nodes(tree,n=>n.type==='button'&&n.props.children==='삭제').length,0,'guest has no host-only delete');
nodes(tree,n=>n.type==='button'&&n.props.children==='이름 바꾸기')[0].props.onClick();tree=render();
nodes(tree,n=>n.type==='input')[0].props.onChange({target:{value:'공유 이름'}});tree=render();nodes(tree,n=>n.type==='form')[0].props.onSubmit({preventDefault(){}});await new Promise(r=>setTimeout(r,0));
assert.deepEqual(calls.at(-1),{name:'rename_multichat',args:{target_room:'room',new_title:'공유 이름'}});assert.deepEqual(invalidated.at(-1).queryKey,['multichats','guest']);
// Ordinary room rename keeps its original table write and route.
globalThis.__listTest.values[0]='active';tree=render();nodes(tree,n=>n.type==='button'&&n.props['aria-label']==='개인방 메뉴')[0].props.onClick();tree=render();nodes(tree,n=>n.type==='button'&&n.props.children==='이름 바꾸기')[0].props.onClick();tree=render();nodes(tree,n=>n.type==='input')[0].props.onChange({target:{value:'개인 이름'}});tree=render();nodes(tree,n=>n.type==='form')[0].props.onSubmit({preventDefault(){}});await new Promise(r=>setTimeout(r,0));assert.equal(calls.at(-1).table,'sessions');
globalThis.__listUser='host';globalThis.__listTest.values[0]='multichat';tree=render();nodes(tree,n=>n.type==='button'&&n.props['aria-label']==='멀티챗 메뉴')[0].props.onClick();tree=render();assert.equal(nodes(tree,n=>n.type==='button'&&n.props.children==='삭제').length,1);
globalThis.__listUser='outsider';tree=render();assert.equal(nodes(tree,n=>n.type==='button'&&n.props['aria-label']==='멀티챗 메뉴').length,0);assert.ok(renderToStaticMarkup(tree).includes('/multichat/room'));
console.log('Multichat list UI: row navigation, independent ellipsis, shared rename RPC, host-only deletion, outsider room navigation and unchanged ordinary rename passed');
