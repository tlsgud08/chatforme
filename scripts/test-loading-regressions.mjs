import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { supabase } = await server.ssrLoadModule('/src/lib/supabase.ts');
  const { fetchSessionConversationCounts } = await server.ssrLoadModule('/src/lib/sessionCounts.ts');
  const { mergeLatestPage } = await server.ssrLoadModule('/src/lib/sessionData.ts');
  const row = turn_index => ({ id: 'm'+turn_index, turn_index });
  const latest = { messages:[row(10),row(11)],oldestTurn:10,hasOlder:true,totalUserTurns:11 };
  const all = mergeLatestPage(Array.from({length:10},(_,i)=>row(i)),latest,{oldestTurn:null,hasOlder:false});
  assert.equal(all.hasOlder,false,'a fully expanded continuous history remains expanded');
  assert.equal(all.oldestTurn,null);
  assert.equal(all.messages.length,12);
  const gap = mergeLatestPage([row(1)],latest,{oldestTurn:null,hasOlder:false});
  assert.equal(gap.hasOlder,true,'a new gap must expose pagination rather than hide missing turns');
  assert.equal(gap.oldestTurn,10);
  const empty = mergeLatestPage([row(1)],{messages:[],oldestTurn:null,hasOlder:false,totalUserTurns:0},{oldestTurn:1,hasOlder:true});
  assert.equal(empty.messages.length,0,'a refreshed empty room must not keep deleted rows');
  const originalFrom = supabase.from, originalRpc = supabase.rpc;
  let failure = { code: 'NETWORK', message: 'offline' }, reads = 0, active = 0, peak = 0;
  supabase.rpc = () => ({
    abortSignal() { return this; },
    then(resolve, reject) { return Promise.resolve({ data: null, error: failure }).then(resolve, reject); },
  });
  supabase.from = () => {
    reads++;
    return {
      select() { return this; }, eq() { return this; }, gt() { return this; }, abortSignal() { return this; },
      then(resolve, reject) {
        active++; peak = Math.max(peak, active);
        return new Promise(done => setImmediate(() => { active--; done({ count: 7, error: null }); })).then(resolve, reject);
      },
    };
  };
  try {
    const ids = Array.from({ length: 25 }, (_, i) => 'session-' + i);
    await assert.rejects(fetchSessionConversationCounts(ids));
    assert.equal(reads, 0, 'a transient RPC failure must not generate 25 more requests');
    failure = { code: 'PGRST202', message: 'missing old-schema RPC' };
    const result = await fetchSessionConversationCounts(ids);
    assert.equal(Object.keys(result).length, 25);
    assert.equal(result[ids[24]], 7, 'legacy schemas retain exact conversation counts');
    assert.equal(peak, 4, 'compatibility requests must have bounded concurrency');
    const controller = new AbortController(); controller.abort();
    reads = 0;
    await assert.rejects(fetchSessionConversationCounts(ids, controller.signal));
    assert.equal(reads, 0, 'cancelled navigation cannot start the compatibility fan-out');
  } finally { supabase.from = originalFrom; supabase.rpc = originalRpc; }
} finally { await server.close(); }

// Run the actual scroll hook over measured viewport fixtures. These represent
// reader movement near the bottom, appends, older-page prepends and edit reflow.
const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const hooks = uri(`
export const useCallback=f=>f;
export const useLayoutEffect=f=>globalThis.__scroll.effects.push(f);
export function useRef(value){const s=globalThis.__scroll,i=s.index++;return s.refs[i]??(s.refs[i]={current:value});}
`);
const source = readFileSync(new URL('../src/hooks/useChatScroll.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { useChatScroll } = await import(uri(compiled.replace("from 'react'", `from '${hooks}'`)));
globalThis.__scroll = { refs: [], effects: [], index: 0 };
let rows = ['a', 'b', 'c', 'd'].map(id => ({ id, height: 300 }));
let scrollTop = 0;
const element = {
  get scrollTop() { return scrollTop; },
  set scrollTop(value) { scrollTop = Math.max(0, Math.min(value, this.scrollHeight - 400)); },
  get scrollHeight() { return rows.reduce((sum, row) => sum + row.height, 0); },
  getBoundingClientRect: () => ({ top: 0, bottom: 400 }),
  querySelectorAll() {
    let y = 0;
    return rows.map(row => {
      const top = y; y += row.height;
      return { dataset: { scrollAnchor: row.id }, getBoundingClientRect: () => ({ top: top - element.scrollTop, bottom: top + row.height - element.scrollTop }) };
    });
  },
};
function render(id = 'one') {
  const state = globalThis.__scroll; state.index = 0; state.effects = [];
  const hook = useChatScroll(id, true); hook.scrollRef.current = element;
  state.effects.forEach(effect => effect()); return hook;
}
try {
  const hook = render();
  assert.equal(element.scrollTop, 800, 'first opening requests the latest turn');
  element.scrollTop = 760; hook.rememberScroll();
  rows.push({ id: 'streaming-response', height: 500 }); render();
  assert.equal(element.scrollTop, 760, 'a new AI response cannot take over a near-bottom reader');
  rows.at(-1).height = 900; render();
  assert.equal(element.scrollTop, 760, 'stream growth cannot force scroll');
  rows.at(-1).id = 'saved-response'; render();
  assert.equal(element.scrollTop, 760, 'completion preserves the viewport');
  rows.unshift({ id: 'older', height: 200 }); render();
  assert.equal(element.scrollTop, 960, 'prepending preserves the same visible message and offset');
  rows[1].height += 100; render();
  assert.equal(element.scrollTop, 1060, 'editing above the viewport preserves its visible anchor');
  element.scrollTop = 150; hook.rememberScroll(); render();
  assert.equal(element.scrollTop, 150, 'reader movement takes precedence over later renders');
  render('two');
  assert.equal(element.scrollTop, element.scrollHeight - 400, 'opening another room initializes independently');
} finally { delete globalThis.__scroll; }
console.log('Loading regressions: transient RPC failure without fan-out, bounded old-schema fallback, cancellation, independent scroll through streaming/completion/edit/prepend passed.');
