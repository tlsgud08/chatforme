import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/lib/friendVisit.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const url='data:text/javascript;base64,'+Buffer.from(js).toString('base64');
const original={performance:Object.getOwnPropertyDescriptor(globalThis,'performance'),sessionStorage:Object.getOwnPropertyDescriptor(globalThis,'sessionStorage')};
let serial=0;
function store(data=new Map()) {return {data,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};}
async function document(type,storage){
 Object.defineProperty(globalThis,'performance',{value:{getEntriesByType:()=>[{type}]},configurable:true,writable:true});
 Object.defineProperty(globalThis,'sessionStorage',{value:storage,configurable:true,writable:true});
 return import(url+'#document-'+(++serial));
}
try{
 const storage=store(), first=await document('navigate',storage), key=first.friendVisitKey('a');
 assert.equal(first.friendVisitKey('a'),key,'rerenders and socket reconnects keep the document visit');
 const reload=await document('reload',storage);assert.equal(reload.friendVisitKey('a'),key,'a reload resumes the prior visit');
 const again=await document('reload',storage);assert.equal(again.friendVisitKey('a'),key,'repeated reloads keep visit history');
 const copied=store(new Map(storage.data)), otherTab=await document('navigate',copied);
 assert.notEqual(otherTab.friendVisitKey('a'),key,'a new tab does not inherit a cloned opener visit');
 const fresh=await document('navigate',storage), freshKey=fresh.friendVisitKey('a');
 assert.notEqual(freshKey,key,'a fresh navigation starts without prior-visit history');
 const accountB=fresh.friendVisitKey('b');assert.notEqual(accountB,freshKey);
 const returnedA=fresh.friendVisitKey('a');assert.notEqual(returnedA,freshKey,'switching accounts does not resume a prior visit');
 fresh.endFriendVisit();assert.equal(storage.data.has('inuchat:friend-visit:a'),false,'logout clears persisted visit identity');
 assert.notEqual(fresh.friendVisitKey('a'),returnedA,'logging in again starts a new visit');
 const invalid=store(new Map([['inuchat:friend-visit:a','invalid identifier']]));
 assert.notEqual((await document('reload',invalid)).friendVisitKey('a'),'invalid identifier');
 const blocked={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')},removeItem(){throw Error('blocked')}};
 const unavailable=await document('reload',blocked), memoryKey=unavailable.friendVisitKey('a');
 assert.equal(unavailable.friendVisitKey('a'),memoryKey,'blocked storage still keeps the visit in memory');
 unavailable.endFriendVisit();assert.notEqual(unavailable.friendVisitKey('a'),memoryKey);
 console.log('Friend visit identity: reloads and reconnects preserve history; fresh navigation, cloned tabs, logout and account changes reset it; invalid/blocked storage handled');
}finally{
 for(const key of ['performance','sessionStorage']){
  if(original[key])Object.defineProperty(globalThis,key,original[key]);else delete globalThis[key];
 }
}
