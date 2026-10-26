import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
const store=new Map(),phases=[],texts=[];
globalThis.sessionStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)};
globalThis.window={location:{origin:'https://fixture.test'}};
const originalFetch=globalThis.fetch;
try{
 const {startOperation,measureOperation}=await server.ssrLoadModule('/src/lib/operationTiming.ts');
 const {openrouterAdapter}=await server.ssrLoadModule('/src/lib/llm/openrouter.ts');
 const timing=startOperation('send'),bodies=[];
 let content;
 const enc=new TextEncoder();
 globalThis.fetch=async(url,init)=>{
   bodies.push(init.body);
   return new Response(new ReadableStream({start(controller){
     controller.enqueue(enc.encode('data: '+JSON.stringify({choices:[{delta:{reasoning:'private reasoning'}}]})+'\n\n'));
     content=()=>{controller.enqueue(enc.encode('data: '+JSON.stringify({choices:[{delta:{content:'private output'}}],usage:{prompt_tokens:1,completion_tokens:2,cost:0}})+'\n\ndata: [DONE]\n\n'));controller.close();};
   }}),{headers:{'content-type':'text/event-stream'}});
 };
 const options={apiKey:'private-key-fixture',sessionId:'private-session-fixture',model:'test/model',reasoning:{send:false},maxOutputTokens:100,
   systemParts:{core:'private system',persona:'',userNote:'',summary:'',keywords:''},messages:[{role:'user',content:'private input'}],
   onChunk:text=>texts.push(text),onPhase:phase=>{phases.push(phase);timing.mark(phase);}};
 const pending=openrouterAdapter.generate(options);
 for(let i=0;i<20&&!phases.includes('model-event');i++)await new Promise(resolve=>setImmediate(resolve));
 assert(phases.includes('model-headers'));assert(phases.includes('model-event'));
 assert(!phases.includes('first-content'),'reasoning-only SSE is not visible output');assert.equal(texts.length,0);
 content();const result=await pending;assert.equal(result.text,'private output');
 timing.mark('save');timing.finish('complete');
 const snapshot=JSON.parse(store.get('inuchat.timings.v1')).at(-1);
 assert.equal(snapshot.outcome,'complete');assert(snapshot.stages['first-content']>=snapshot.stages['model-event']);
 for(const field of ['private-key-fixture','private-session-fixture','private input','private system','private output','private reasoning'])assert(!store.get('inuchat.timings.v1').includes(field));
 assert.deepEqual([...new Set(phases)],['model-request','model-headers','model-event','first-content','model-complete']);
 // An observer failure cannot change the model payload or fail a paid result.
 globalThis.fetch=async(url,init)=>{bodies.push(init.body);return new Response('data: '+JSON.stringify({choices:[{delta:{content:'answer'}}]})+'\n\ndata: [DONE]\n\n');};
 assert.equal((await openrouterAdapter.generate({...options,onPhase:()=>{throw Error('observer unavailable');}})).text,'answer');
 assert.equal(bodies[0],bodies[1],'instrumentation is absent from the actual serialized request');
 for(let i=0;i<35;i++){const t=startOperation('works');t.finish('complete');t.finish('failed');}
 assert.equal(JSON.parse(store.get('inuchat.timings.v1')).length,30,'history and duplicate completion are bounded');
 globalThis.sessionStorage.setItem=()=>{throw Error('blocked storage');};
 assert.equal(await measureOperation('works',async()=>42),42);
 await assert.rejects(measureOperation('works',async()=>{throw Error('real read failed');}),/real read failed/);
 console.log('Operation timings: reasoning/event/content distinction, unchanged model body, no prompt/key/account data, bounded tab records and non-fatal observers/storage passed');
}finally{globalThis.fetch=originalFetch;delete globalThis.window;delete globalThis.sessionStorage;await server.close();}
