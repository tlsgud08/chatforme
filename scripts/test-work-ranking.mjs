import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try {
 const {rankWorks,workSort,fetchWorkRankings}=await server.ssrLoadModule('/src/lib/workRanking.ts');
 const {supabase}=await server.ssrLoadModule('/src/lib/supabase.ts');
 const works=[{id:'a',created_at:'2026-01-01'},{id:'b',created_at:'2026-01-02'},{id:'c',created_at:'2026-01-03'},{id:'d',created_at:'2026-01-03'}];
 const stats={a:{sessions:4,dollars:1},b:{sessions:1,dollars:10},c:{sessions:1,dollars:10},d:{sessions:0,dollars:0}};
 assert.deepEqual(rankWorks(works,'sessions',stats).map(x=>x.id),['a','c','b','d']);
 assert.deepEqual(rankWorks(works,'cost',stats).map(x=>x.id),['c','b','a','d']);
 assert.deepEqual(rankWorks(works,'latest',stats).map(x=>x.id),['c','d','b','a']);
 assert.equal(works[0].id,'a','source cache is not sorted in place');
 assert.equal(workSort('unrecognized'),'latest');assert.equal(workSort(null),'latest');
 let requests=0;const rpc=supabase.rpc;
 supabase.rpc=(_name,args)=>{requests++;return Promise.resolve({data:args.target_work_ids.map(work_id=>({work_id,session_count:'2',total_cost_usd:'0.125'})),error:null});};
 assert.deepEqual((await fetchWorkRankings(['a','a','b'])).a,{sessions:2,dollars:0.125});
 assert.equal(requests,1,'batch request rather than one call per work');
 await fetchWorkRankings(Array.from({length:501},(_,i)=>String(i)));assert.equal(requests,3,'large catalogs stay below RPC row limits');
 supabase.rpc=()=>Promise.resolve({data:[],error:null});await assert.rejects(fetchWorkRankings(['a']),/일부/);
 supabase.rpc=()=>Promise.resolve({data:null,error:new Error('offline')});await assert.rejects(fetchWorkRankings(['a']),/offline/);
 supabase.rpc=rpc;
 console.log('Work ranking: descending sessions/cost, newest tie-break, stable source, compact modes, batching and failure handling passed');
} finally {await server.close();}
