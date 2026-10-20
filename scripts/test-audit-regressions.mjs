import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Run real page handlers against deferred requests to reproduce response races
// and failed writes without using production accounts or a paid model.
const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const hooks = uri(`
export const useEffect=f=>globalThis.__audit.effects.push(f);
export const useRef=v=>({current:v});
export function useState(initial){const s=globalThis.__audit,i=s.index++;if(!(i in s.values))s.values[i]=typeof initial==='function'?initial():initial;return [s.values[i],next=>{s.values[i]=typeof next==='function'?next(s.values[i]):next;}];}
`);
const calls = [], notices = [], invalidations = [];
function presentationUri(name) {
  const source = readFileSync(new URL(`../src/components/${name}.tsx`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  return uri(js.replace(/from\s+(['"])([^'"]+)\1/g, (_, _quote, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`));
}
const imports = {
  '@/components/InterfaceIcon': presentationUri('InterfaceIcon'),
  '@/components/ModernPageHeading': presentationUri('ModernPageHeading'),
  react: hooks,
  'react-router-dom': uri(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))};export const useNavigate=()=>()=>{};export function Link({to,children,...props}){return createElement('a',{...props,href:to},children);}`),
  '@tanstack/react-query': uri(`export const useQueryClient=()=>({invalidateQueries:async value=>globalThis.__auditInvalidations.push(value),setQueriesData:()=>{}});export const useQuery=()=>({data:[],isLoading:false,refetch:async()=>{}});`),
  '@/hooks/useAuth': uri(`export const useAuth=()=>({user:{id:'owner'},isAdmin:false});`),
  '@/lib/supabase': uri(`export const supabase={from:table=>globalThis.__auditFrom(table)};`),
  '@/lib/works': uri(`export const WORK_LIST_COLUMNS='id,creator_id,title';`),
  '@/lib/toast': uri(`export const showToast=message=>globalThis.__auditNotices.push(message);`),
  '@/components/ConfirmDialog': uri(`export default function ConfirmDialog(){return null;}`),
};
globalThis.__auditNotices = notices;
globalThis.__auditInvalidations = invalidations;
function loadPage(name) {
  const source = readFileSync(new URL(`../src/pages/${name}.tsx`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  return import(uri(js.replace(/from\s+(['"])([^'"]+)\1/g, (_, _quote, specifier) => `from ${JSON.stringify(imports[specifier] ?? import.meta.resolve(specifier))}`)));
}
function render(Page, values) {
  globalThis.__audit = {index:0,values,effects:[]};
  return Page();
}
function elements(node) {
  if(Array.isArray(node))return node.flatMap(elements);
  return node?.props ? [node,...elements(node.props.children)] : [];
}
const flush = () => new Promise(resolve => setImmediate(resolve));
let respond;
globalThis.__auditFrom = table => {
  const request={table};
  const chain={
    select:columns=>{request.columns=columns;return chain;},
    insert:patch=>{request.insert=patch;calls.push(request);return chain;},
    update:patch=>{request.update=patch;calls.push(request);return chain;},
    delete:()=>{request.delete=true;calls.push(request);return chain;},
    eq:()=>chain,in:()=>chain,order:()=>chain,limit:()=>chain,single:()=>chain,
    or:filter=>{request.filter=filter;return chain;},ilike:(_,filter)=>{request.filter=filter;return chain;},
    abortSignal:signal=>{request.signal=signal;return chain;},
    then:(resolve,reject)=>Promise.resolve().then(()=>respond(request)).then(resolve,reject),
  };
  return chain;
};

const {default:SearchPage}=await loadPage('SearchPage');
const timers=[];
const originalTimeout=globalThis.setTimeout, originalClear=globalThis.clearTimeout;
globalThis.setTimeout=callback=>{timers.push(callback);return callback;};
globalThis.clearTimeout=callback=>{const i=timers.indexOf(callback);if(i>=0)timers.splice(i,1);};
try {
  const deferred=[];
  respond=request=>request.table==='profiles'?{data:[],error:null}:new Promise(resolve=>deferred.push({request,resolve}));
  const old=['old','works',[],[],false,''];
  render(SearchPage,old);
  const cleanupOld=globalThis.__audit.effects[1]();timers.shift()();await flush();
  cleanupOld();
  const latest=['latest','works',[],[],false,''];
  render(SearchPage,latest);
  const cleanupLatest=globalThis.__audit.effects[1]();timers.shift()();await flush();
  deferred[1].resolve({data:[{id:'latest-result',creator_id:'author',title:'latest'}],error:null});await flush();
  deferred[0].resolve({data:[{id:'old-result',creator_id:'author',title:'old'}],error:null});await flush();
  assert.equal(latest[2][0].id,'latest-result');
  assert.deepEqual(old[2],[],'superseded response cannot update page state');
  assert.equal(deferred[0].request.signal.aborted,true);
  cleanupLatest();
  const blank=['','works',[{id:'obsolete'}],[],true,''];
  render(SearchPage,blank);globalThis.__audit.effects[1]();
  assert.deepEqual(blank[2],[]);assert.equal(blank[4],false);
  respond=()=>({data:null,error:{message:'offline'}});
  const failed=['failed','users',[],[],false,''];
  render(SearchPage,failed);globalThis.__audit.effects[1]();timers.shift()();await flush();
  assert.ok(failed[5].includes('불러오지 못했습니다'));assert.equal(failed[4],false);
} finally {globalThis.setTimeout=originalTimeout;globalThis.clearTimeout=originalClear;}

const {default:FavoritesPage}=await loadPage('FavoritesPage');
const inaccessible={work_id:'hidden',created_at:'',works:null};
const favValues=[[inaccessible],false,'',null];
let view=render(FavoritesPage,favValues);
assert.ok(renderToStaticMarkup(view).includes('접근할 수 없는 작품'));
respond=()=>({error:{message:'offline'}});
await elements(view).find(el=>el.props['aria-label']==='하트 목록에서 삭제').props.onClick();
assert.equal(favValues[0].length,1,'failed deletion retains the favorite');
assert.ok(notices.at(-1).includes('삭제 실패'));
respond=()=>({error:null});
view=render(FavoritesPage,favValues);
await elements(view).find(el=>el.props['aria-label']==='하트 목록에서 삭제').props.onClick();
assert.equal(favValues[0].length,0);
assert.ok(invalidations.some(item=>item.queryKey[0]==='user-favorites'));
assert.ok(invalidations.some(item=>item.queryKey[0]==='work-fav-me'));

const palette={accent:'#123456',accentText:'#ffffff',main:'#000000',mainText:'#ffffff'};
const original={id:'original',title:'Original',creator_id:'owner',default_theme_id:'shared',default_theme_variant:'light'};
const shared={id:'shared',name:'Garden',description:'',dark_colors:palette,light_colors:palette,ai_prompt:'Garden condition',day_night_enabled:true,use_day_night_variants:false,work_shared:true};
const privateTheme={...shared,id:'private',name:'Private',work_shared:false};
respond=request=>{
 if(request.table==='works'&&!request.insert&&!request.update)return {data:original,error:null};
 if(request.table==='works'&&request.insert)return {data:{id:'copied-work'},error:null};
 if(request.table==='themes'&&!request.insert)return {data:[shared,privateTheme],error:null};
 if(request.table==='themes'&&request.insert)return {data:{id:'copied-theme'},error:null};
 return {data:[],error:null};
};
// Supply a list row to the real page's useQuery result for its menu handler.
// Recompile with an explicit query fixture, leaving all mutation code intact.
imports['@tanstack/react-query']=uri(`export const useQueryClient=()=>({invalidateQueries:async()=>{},setQueriesData:()=>{}});export const useQuery=()=>({data:[{id:'original',title:'Original',creator_id:'owner'}],isLoading:false,refetch:async()=>{}});`);
const {default:CreateWithWork}=await loadPage('CreatePage');
view=render(CreateWithWork,['original',null,false]);
await elements(view).find(el=>el.type==='button'&&el.props.children==='작품 복제').props.onClick();
await flush();
const copied=calls.filter(call=>call.table==='themes'&&call.insert);
assert.equal(copied.length,1,'personal scene themes do not become shared on copy');
assert.equal(copied[0].insert.ai_prompt,shared.ai_prompt);
assert.equal(copied[0].insert.day_night_enabled,true);
assert.equal(copied[0].insert.use_day_night_variants,false);
assert.deepEqual(copied[0].insert.dark_colors,palette);
console.log('Audit regressions: superseded/empty/error searches, inaccessible favorites, failed/successful deletion and complete shared-theme copies OK');
