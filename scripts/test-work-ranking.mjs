import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try {
 const {rankWorks,workSort,fetchWorkRankings,loadWorkSort,saveWorkSort}=await server.ssrLoadModule('/src/lib/workRanking.ts');
 const {supabase}=await server.ssrLoadModule('/src/lib/supabase.ts');
 const works=[{id:'a',created_at:'2026-01-01'},{id:'b',created_at:'2026-01-02'},{id:'c',created_at:'2026-01-03'},{id:'d',created_at:'2026-01-03'}];
 const stats={a:{sessions:4,messages:1,dollars:50},b:{sessions:1,messages:10,dollars:20},c:{sessions:1,messages:10},d:{sessions:0,messages:0}};
 assert.deepEqual(rankWorks(works,'sessions',stats).map(x=>x.id),['a','c','b','d']);
 assert.deepEqual(rankWorks(works,'messages',stats).map(x=>x.id),['c','b','a','d']);
 assert.deepEqual(rankWorks(works,'latest',stats).map(x=>x.id),['c','d','b','a']);
 assert.deepEqual(rankWorks(works,'cost',stats).map(x=>x.id),['a','b','c','d']);
 assert.equal(works[0].id,'a','source cache is not sorted in place');
 assert.equal(workSort('unrecognized'),'latest');assert.equal(workSort(null),'latest');
 const stored=new Map();globalThis.localStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)};
 const {loadWorkCredits,saveWorkCredits}=await server.ssrLoadModule('/src/lib/workCredits.ts');
 globalThis.window=new EventTarget();let changes=0;window.addEventListener('inuchat:work-credits-changed',()=>changes++);
 assert.equal(loadWorkCredits(),false,'credit setting defaults off');saveWorkCredits(true);assert.equal(loadWorkCredits(),true);
 saveWorkCredits(false);assert.equal(loadWorkCredits(),false);assert.equal(changes,2);delete globalThis.window;
 for(const value of ['latest','messages','sessions']) { saveWorkSort(value); assert.equal(loadWorkSort(),value,'restored after navigating away/remounting'); }
 assert.equal(workSort('cost'),'latest','credit sorting defaults disabled');
 assert.equal(workSort('cost',true),'cost');
 saveWorkSort('cost');assert.equal(loadWorkSort(true),'cost');assert.equal(loadWorkSort(false),'latest');
 stored.set('inuchat.workSort','invalid');assert.equal(loadWorkSort(),'latest');
 globalThis.localStorage={getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}};
 assert.equal(loadWorkSort(),'latest');assert.doesNotThrow(()=>saveWorkSort('sessions'));delete globalThis.localStorage;
 let requests=0;const rpc=supabase.rpc;
 supabase.rpc=(_name,args)=>{requests++;return Promise.resolve({data:args.target_work_ids.map(work_id=>({work_id,session_count:'2',message_count:'12'})),error:null});};
 assert.deepEqual((await fetchWorkRankings(['a','a','b'])).a,{sessions:2,messages:12});
 assert.equal(requests,1,'batch request rather than one call per work');
 await fetchWorkRankings(Array.from({length:501},(_,i)=>String(i)));assert.equal(requests,3,'large catalogs stay below RPC row limits');
 supabase.rpc=()=>Promise.resolve({data:[],error:null});await assert.rejects(fetchWorkRankings(['a']),/일부/);
 supabase.rpc=()=>Promise.resolve({data:null,error:new Error('offline')});await assert.rejects(fetchWorkRankings(['a']),/offline/);
 supabase.rpc=(_name,args)=>Promise.resolve({data:args.target_work_ids.map(work_id=>({work_id,session_count:2,message_count:12,total_cost_usd:args.include_credits?'1.25':null})),error:null});
 assert.equal((await fetchWorkRankings(['a'],undefined,true)).a.dollars,1.25);
 assert.equal((await fetchWorkRankings(['a'])).a.dollars,undefined);
 supabase.rpc=rpc;
 console.log('Work ranking: descending sessions/messages, newest tie-break, stable source, compact modes, batching and failure handling passed');
} finally {await server.close();}
