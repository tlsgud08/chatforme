// Read-only synthetic comparison: actual pre-#133 reader vs current RPC/SQL.
// Local PGlite CPU times are not mobile network/production latency measurements.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'vite';
const compile = source => ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const old = execFileSync('git',['show','dc0d056564007da9de78ff84b4d30ad1d79c7a53:src/pages/ChatPage.tsx'],{encoding:'utf8'});
const beforeSql=execFileSync('git',['show','d3aefa421b4ac0b90eb1a9ba68d29ec4370ba673:supabase/migrations/20261025051847_chat_and_editor_recovery.sql'],{encoding:'utf8'});
const current = readFileSync('src/pages/ChatPage.tsx','utf8');
function declaration(source,name) {
  const file=ts.createSourceFile('ChatPage.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let found;
  const walk=n=>{if(ts.isFunctionDeclaration(n)&&n.name?.text===name)found=n.getText(file);ts.forEachChild(n,walk);};walk(file);
  assert(found,name);return compile(found);
}
const db=new PGlite(),dir=new URL('../supabase/migrations/',import.meta.url);
const vite=await createServer({server:{middlewareMode:true},appType:'custom'});
const owner='00000000-0000-0000-0000-000000000001',work='10000000-0000-0000-0000-000000000001';
const query=async(sql,params=[]) => (await db.query(sql,params)).rows;
let reads=0;
const mock={from:table=>{
  assert.equal(table,'messages');let room,offset=0,limit=500;
  const chain={select:()=>chain,eq:(key,value)=>{assert.equal(key,'session_id');room=value;return chain;},
    order:()=>chain,range:(a,b)=>{offset=a;limit=b-a+1;return chain;},then(resolve,reject){reads++;
      return query('select * from messages where session_id=$1 order by created_at,id limit $2 offset $3',[room,limit,offset])
        .then(data=>({data,error:null})).then(resolve,reject);}};return chain;
}};
const readFull=vm.runInNewContext(declaration(old,'fetchAllSessionMessages')+'\nfetchAllSessionMessages',{supabase:mock,MESSAGE_FETCH_BATCH_SIZE:500});
const functions=['messagesAfterSummary','buildHistory','getActiveKeywordContents'].map(name=>declaration(current,name)).join('\n');
const helpers=vm.runInNewContext(functions+'\n({buildHistory,getActiveKeywordContents})',{
  session:null,startConfig:{keep_turns:5},keywordBooks:[{keywords:['body'],content:'keyword content',activation_turns:3}],
});
const quantile=(a,q)=>[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*q))];
try {
  await db.exec(`create role authenticated;create role anon;create role service_role;create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.email() returns text language sql stable as $$select 'fixture@example.test'::text$$;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');`);
  for(const file of readdirSync(dir).filter(n=>/^00\d\d_/.test(n)).sort()){
    if(file.startsWith('0012_')||file.startsWith('0032_'))continue;
    let source=readFileSync(new URL(file,dir),'utf8');
    if(file.startsWith('0003_follows')||file.startsWith('0008_'))source=source.split('insert into storage.buckets')[0];
    source=source.replace(/create extension if not exists pgcrypto;/gi,'').replace(/do \$\$ begin alter publication[\s\S]*?end \$\$;/gi,'');
    await db.exec(source);
  }
  for(const file of readdirSync(dir).filter(n=>n.startsWith('2026')).sort())await db.exec(readFileSync(new URL(file,dir),'utf8'));
  const baselineFunction=beforeSql.match(/create or replace function public\.session_generation_context\([\s\S]*?end \$\$;/)[0]
    .replace('public.session_generation_context(', 'public.session_generation_context_before(');
  await db.exec(baselineFunction);
  await db.exec(`grant usage on schema public,auth to authenticated;grant select,insert,update,delete on all tables in schema public to authenticated;
    insert into auth.users(id,email) values('${owner}','fixture@example.test');
    insert into works(id,creator_id,title,visibility) values('${work}','${owner}','Synthetic benchmark','private');`);
  const {assemblePrompt}=await vite.ssrLoadModule('/src/lib/prompt/assemble.ts');
  const {buildOpenRouterMessages,resolvePromptCache}=await vite.ssrLoadModule('/src/lib/llm/promptCache.ts');
  const {normalizeMessages}=await vite.ssrLoadModule('/src/lib/llm/index.ts');
  const result=[];
  for(const [index,turns] of [20,300,700].entries()){
    const room='20000000-0000-0000-0000-'+String(index+1).padStart(12,'0'),cutoff=Math.floor(turns*0.8);
    await db.exec('reset role');
    await db.query("insert into sessions(id,user_id,work_id,summary,summary_last_turn)values($1,$2,$3,'live summary',$4)",[room,owner,work,cutoff]);
    await db.query(`insert into messages(session_id,role,content,turn_index,created_at)
      select $1,case when n%2=0 then 'assistant' else 'user' end,repeat('body fixture ',230),(n+1)/2,
      '2026-01-02'::timestamptz+n*interval '1 second' from generate_series(1,$2::integer)n`,[room,turns*2]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await db.exec('set role authenticated');
    const fullTimes=[],rpcTimes=[],beforeTimes=[];let fullBytes,rpcBytes,fullReads;
    for(let trial=-1;trial<30;trial++){
      let full,context,before;reads=0;
      const direct=async()=>{const start=performance.now();full=await readFull(room);fullReads=reads;if(trial>=0)fullTimes.push(performance.now()-start);};
      const rpc=async()=>{const start=performance.now();context=(await query('select session_generation_context($1,0,3,false) value',[room]))[0].value;if(trial>=0)rpcTimes.push(performance.now()-start);};
      if(trial%2){await rpc();await direct();}else{await direct();await rpc();}
      const beforeStart=performance.now();before=(await query('select session_generation_context_before($1,0,3,false) value',[room]))[0].value;
      if(trial>=0)beforeTimes.push(performance.now()-beforeStart);
      assert.deepEqual(context,before,'single-pass query cannot change any returned row, ordering, metadata or source hash');
      function wire(rows){
        const active=rows.filter(m=>m.is_active_variant);
        const history=helpers.buildHistory(active,cutoff);
        const cache=resolvePromptCache(true,'google/fixture',null,history,true);
        const prompt=assemblePrompt({systemPrompt:'system',mainPrompt:'main',summary:'live summary',
          keywordBookContents:helpers.getActiveKeywordContents(active,'next input'),
          history:history.map(m=>({...m,cacheBreakpoint:m.id===cache.messageId})),latestUserMessage:'next input'});
        return JSON.stringify(buildOpenRouterMessages({model:'google/fixture',...prompt,messages:normalizeMessages(prompt.messages),cacheSystemOnly:cache.systemOnly}));
      }
      assert.equal(wire(context.messages),wire(full),'actual model messages must be identical');
      fullBytes=Buffer.byteLength(JSON.stringify(full));rpcBytes=Buffer.byteLength(JSON.stringify(context));
    }
    result.push({turns,rows:turns*2,trials:30,full:{requests:fullReads,bytes:fullBytes,medianMs:+quantile(fullTimes,0.5).toFixed(2),p95Ms:+quantile(fullTimes,0.95).toFixed(2)},
      before:{requests:1,bytes:rpcBytes,medianMs:+quantile(beforeTimes,0.5).toFixed(2),p95Ms:+quantile(beforeTimes,0.95).toFixed(2)},
      current:{requests:1,bytes:rpcBytes,medianMs:+quantile(rpcTimes,0.5).toFixed(2),p95Ms:+quantile(rpcTimes,0.95).toFixed(2)}});
  }
  console.log(JSON.stringify({environment:'local PGlite; excludes network/transfer/mobile/model; actual source and SQL; no paid calls',result},null,2));
}finally{await vite.close();await db.close();}
