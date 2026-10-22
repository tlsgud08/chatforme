import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const uri=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {createDraftWriter}=await import(uri(compile(readFileSync(new URL('../src/lib/draftWriter.ts',import.meta.url),'utf8'))));
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const writes=[];let release;
const writer=createDraftWriter(async text=>{writes.push(text);if(writes.length===1)await new Promise(resolve=>release=resolve);},1);
writer.push('first');await tick();
for(let n=0;n<100;n++)writer.push('latest '+n);
assert.equal(writes.length,1,'never start a second concurrent network write');
release();await writer.flush();
assert.deepEqual(writes,['first','latest 99']);
writer.push('must not overwrite the final response');await writer.stop();await tick();
assert.equal(writes.length,2);
const failed=createDraftWriter(async()=>{throw Error('offline');},1);
failed.push('partial');await assert.rejects(failed.flush(),/offline/);await failed.stop();

const source=readFileSync(new URL('../src/pages/ChatPage.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function fn(name){let found;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)found=n.getText(ast);ts.forEachChild(n,visit);}visit(ast);assert.ok(found);return compile(found);}
const match=vm.runInNewContext(fn('getActiveKeywordContents')+'\ngetActiveKeywordContents',{keywordBooks:[{keywords:['trigger'],content:'lore',activation_turns:3}]});
assert.deepEqual(Array.from(match([{role:'user',content:'trigger'},{role:'user',content:'previous'}],'current')),['lore']);
assert.deepEqual(Array.from(match([{role:'user',content:'trigger'},{role:'user',content:'old'},{role:'user',content:'previous'}],'current')),[]);
assert.match(source,/getActiveKeywordContents\(baseMessages\.filter\(message => message\.id !== rerollUserMessage\?\.id\), promptText\)/,'real send path must exclude the current turn before the matching function appends it');

// Real generated-summary source with a concurrent generation must return before
// requesting a paid model or mutating memory.
let paidCalls=0;
const summary=vm.runInNewContext(fn('generateSummary')+'\ngenerateSummary',{
  session:{id:'s'},profile:{},messages:[],sendInFlightRef:{current:true},generate:()=>paidCalls++,
});
await summary();assert.equal(paidCalls,0);
console.log('Integrity client: bounded latest-only draft writes, failures/stop, keyword boundary and generation conflict guard passed');
