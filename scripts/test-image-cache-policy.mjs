import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
const uri = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const compile = file => ts.transpileModule(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const policyUri = uri(compile('src/lib/imageCachePolicy.ts'));
const { normalizeImageCachePolicy, imageExpirationOptions, sendImageCachePolicy } = await import(policyUri);
const { createImageCacheRuntime } = await import(uri(compile('src/lib/imageCacheRuntime.ts').replace("'./imageCachePolicy'", JSON.stringify(policyUri))));
assert.deepEqual(normalizeImageCachePolicy({}), {maxEntries:1000,maxAgeDays:null});
assert.deepEqual(normalizeImageCachePolicy({maxEntries:2000,maxAgeDays:7}), {maxEntries:2000,maxAgeDays:7});
for (const value of [0,-1,1.5,10001,'2000',NaN,Infinity]) assert.equal(normalizeImageCachePolicy({maxEntries:value}).maxEntries,1000);
assert.deepEqual(imageExpirationOptions(normalizeImageCachePolicy({})), {maxEntries:1000});
assert.equal(imageExpirationOptions({maxEntries:2000,maxAgeDays:7}).maxAgeSeconds, 604800);
const stores = new Map();
const storage = {
 keys: async () => [...stores.keys()],
 open: async name => {
  if (!stores.has(name)) stores.set(name,new Map());
  const map=stores.get(name);
  return {match:async key=>map.get(String(key))?.clone(),put:async(key,value)=>{map.set(String(key),value.clone());},keys:async()=>[...map.keys()].map(key=>new Request(key)),delete:async key=>map.delete(String(key))};
 },
 delete:async name=>stores.delete(name),
};
let now = 1000000000;
const timestamps = new Map();
const seen = [];
const imageName = 'chat-markdown-images-v1';
function makeExpiration(policy) {
 seen.push({...policy});
 return {
  updateTimestamp:async url=>{ timestamps.set(url,now++); },
  isURLExpired:async url=>!timestamps.has(url)||timestamps.get(url)<now-policy.maxAgeDays*86400000,
  expireEntries:async()=>{
   const items=[...timestamps].sort((a,b)=>b[1]-a[1]);
   for(const [index,[url,when]] of items.entries()) if(index>=policy.maxEntries||policy.maxAgeDays!==null&&when<now-policy.maxAgeDays*86400000){timestamps.delete(url);await(await storage.open(imageName)).delete(url);}
  },
  delete:async()=>{timestamps.clear();},
 };
}
const marker='https://app.test/__image-cache-policy';
let runtime=createImageCacheRuntime(storage,marker,makeExpiration);
await runtime.set({maxEntries:3,maxAgeDays:null});
for(const id of ['a','b','c']){const url='https://img.test/'+id;await(await storage.open(imageName)).put(url,new Response(id));await runtime.updated(url);}
await runtime.use('https://img.test/a',new Response('a'),async()=>{});
await runtime.set({maxEntries:2,maxAgeDays:null});
assert.deepEqual((await(await storage.open(imageName)).keys()).map(x=>x.url).sort(),['https://img.test/a','https://img.test/c']);
runtime=createImageCacheRuntime(storage,marker,makeExpiration);
await runtime.updated('https://img.test/a');assert.equal(seen.at(-1).maxEntries,2,'worker restart restores the last applied account limit');
await runtime.set({maxEntries:1000,maxAgeDays:1});
now+=86400001;
let removed=false;
assert.equal(await runtime.use('https://img.test/a',new Response('old'),async()=>{removed=true;}),null);assert(removed);
await runtime.set({maxEntries:1000,maxAgeDays:null});
assert.equal(await(await runtime.use('https://img.test/a',new Response('kept'),async()=>{})).text(),'kept','unlimited retains old entries');
await runtime.clear(()=>storage.delete(imageName));
assert(stores.get('image-cache-settings-v1').has(marker),'quota cleanup preserves account policy');

const originalCaches=Object.getOwnPropertyDescriptor(globalThis,'caches');
const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
try {
 Object.defineProperty(globalThis,'caches',{configurable:true,value:storage});
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage:{estimate:async()=>({usage:123456,quota:987654})}}});
 await(await storage.open(imageName)).put('https://img.test/one',new Response('x'));
 await(await storage.open('work-thumbnails-v1')).put('https://img.test/thumb',new Response('x'));
 const {readImageCacheUsage}=await import(uri(compile('src/lib/imageCache.ts')));
 assert.deepEqual(await readImageCacheUsage(),{chatImages:1,thumbnails:1,usage:123456,quota:987654});
 globalThis.navigator.storage.estimate=async()=>{throw Error('denied');};
 assert.equal((await readImageCacheUsage()).chatImages,1);assert.equal((await readImageCacheUsage()).usage,null);
 assert.equal(await sendImageCachePolicy({maxEntries:1000,maxAgeDays:null}),false,'no controller requires normal worker activation');
 globalThis.navigator.serviceWorker={controller:{postMessage(message,ports){assert.equal(message.policy.maxEntries,2000);ports[0].postMessage({ok:true});}}};
 assert.equal(await sendImageCachePolicy({maxEntries:2000,maxAgeDays:null}),true);
} finally {
 if(originalCaches)Object.defineProperty(globalThis,'caches',originalCaches);else delete globalThis.caches;
 if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);else delete globalThis.navigator;
}
const db=new PGlite();
try {
 await db.exec(`create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select current_setting('request.jwt.claim.sub',true)::uuid$$;create table profiles(id uuid primary key);alter table profiles enable row level security;create policy own on profiles to authenticated using(id=(select auth.uid())) with check(id=(select auth.uid()));grant usage on schema public,auth to authenticated;grant select,update on profiles to authenticated;`);
 await db.exec(readFileSync(new URL('../supabase/migrations/20261125010022_account_image_cache_policy.sql',import.meta.url),'utf8'));
 const a='00000000-0000-0000-0000-000000000001', b='00000000-0000-0000-0000-000000000002';
 await db.query('insert into profiles(id) values($1),($2)',[a,b]);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[a]);await db.exec('set role authenticated');
 assert.equal((await db.query('select * from profiles')).rows[0].image_cache_max_entries,1000);
 assert.equal((await db.query('select * from profiles')).rows[0].image_cache_max_age_days,null);
 await db.query('update profiles set image_cache_max_entries=2000,image_cache_max_age_days=7 where id=$1',[a]);
 assert.equal((await db.query('select * from profiles')).rows[0].image_cache_max_entries,2000);
 assert.equal((await db.query('update profiles set image_cache_max_entries=10 where id=$1 returning id',[b])).rows.length,0);
 for(const value of [0,-1,10001]) await assert.rejects(()=>db.query('update profiles set image_cache_max_entries=$1',[value]),/check constraint/);
 await assert.rejects(()=>db.query('update profiles set image_cache_max_age_days=0'),/check constraint/);
} finally {await db.close();}
console.log('Image cache policy: account defaults/RLS/constraints, runtime persistence, LRU, unlimited/expiry, quota cleanup, usage estimates and worker acknowledgement passed');

// Operate the actual settings form with deterministic hooks and recording IO.
const { createElement, Fragment } = await import('react');
const { default: vm } = await import('node:vm');
let state = [], cursor = 0, preference = {maxEntries:1000,maxAgeDays:null}, failedSave = false, enabledUsage;
const writes = [], applied = [], messages = [];
function nodes(n, predicate, result=[]) { if(!n||typeof n!=='object')return result;if(predicate(n))result.push(n);for(const child of [n.props?.children].flat(Infinity))nodes(child,predicate,result);return result; }
const textOf=n=>typeof n==='string'?n:typeof n==='number'?String(n):n&&typeof n==='object'?[n.props?.children].flat(Infinity).map(textOf).join(''):'';
const hooks={useEffect:fn=>{fn();},useState(initial){const i=cursor++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return[state[i],next=>{state[i]=typeof next==='function'?next(state[i]):next;}];},useSyncExternalStore:()=> 'modern'};
function load(file,name,env) {
 const source=readFileSync(new URL('../'+file,import.meta.url),'utf8').replace(/^import .*$/gm,'').replace('export default function','function');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React,jsxFactory:'jsx',jsxFragmentFactory:'Fragment'}}).outputText.replace('export {};','');
 return vm.runInNewContext(output+'\n'+name,{jsx:createElement,Fragment,...env});
}
const Settings=load('src/components/ImageCacheSettings.tsx','ImageCacheSettings',{
 ...hooks,InterfaceIcon:'Icon',Toggle:'Toggle',useAuth:()=>({user:{id:'owner'}}),
 imageCachePolicyKey:id=>['image-cache-policy',id],useImageCachePolicy:()=>({data:preference,isError:false}),
 useQueryClient:()=>({setQueryData:(key,value)=>{assert.equal(key[1],'owner');preference=value;}}),
 useQuery:args=>{enabledUsage=args.enabled;return{data:{chatImages:12,thumbnails:3,usage:1024**2,quota:1024**3},isFetching:false,refetch:async()=>{}};},
 readImageCacheUsage:()=>{},loadInterfaceDesign:()=> 'modern',subscribeInterfaceDesign:()=>()=>{},
 sendImageCachePolicy:async value=>{applied.push(value);return true;},clearImageCaches:async()=>{messages.push('clear');},
 supabase:{from:table=>({update:patch=>({eq:(key,id)=>({select:()=>({single:async()=>{writes.push({table,patch,key,id});return failedSave?{error:{message:'offline'}}:{data:{id},error:null};}})})})})},
});
const renderSettings=active=>{cursor=0;return Settings({active});};
let tree=renderSettings(false);assert.equal(enabledUsage,false,'usage is not scanned while another settings section is open');
tree=renderSettings(true);assert.equal(enabledUsage,true);assert(textOf(tree).includes('12 / 1000개'));assert(textOf(tree).includes('1.0 MB'));
const inputs=()=>nodes(tree,n=>n.type==='input');
inputs()[0].props.onChange({target:{value:'2000'}});tree=renderSettings(true);
nodes(tree,n=>n.props['aria-label']==='이미지 캐시 보관 기간 무제한')[0].props.onChange(false);tree=renderSettings(true);
inputs()[1].props.onChange({target:{value:'7'}});tree=renderSettings(true);
nodes(tree,n=>n.type==='form')[0].props.onSubmit({preventDefault(){}});await new Promise(r=>setTimeout(r,0));tree=renderSettings(true);
assert.deepEqual(JSON.parse(JSON.stringify(writes.at(-1))),{table:'profiles',patch:{image_cache_max_entries:2000,image_cache_max_age_days:7},key:'id',id:'owner'});
assert.equal(applied.at(-1).maxEntries,2000);assert(textOf(tree).includes('保存')===false);assert(textOf(tree).includes('저장했습니다.'));
failedSave=true;inputs()[0].props.onChange({target:{value:'3000'}});tree=renderSettings(true);
nodes(tree,n=>n.type==='form')[0].props.onSubmit({preventDefault(){}});await new Promise(r=>setTimeout(r,0));tree=renderSettings(true);
assert(textOf(tree).includes('저장 실패'));assert.equal(preference.maxEntries,2000,'failed saves never replace the applied policy');
assert.equal(inputs()[0].props.value,'3000','failed saves retain the user draft');
inputs()[0].props.onChange({target:{value:'0'}});tree=renderSettings(true);
assert(nodes(tree,n=>n.type==='button'&&n.props.type==='submit')[0].props.disabled);
console.log('Cache settings UI: lazy usage display, account-only field save, unlimited/days inputs, immediate apply, failure draft preservation and validation passed');
