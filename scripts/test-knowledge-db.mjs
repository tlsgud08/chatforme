import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite(),
  dir = new URL("../supabase/migrations/", import.meta.url);
const a = "00000000-0000-0000-0000-000000000001",
  b = "00000000-0000-0000-0000-000000000002",
  work = "10000000-0000-0000-0000-000000000001",
  room = "20000000-0000-0000-0000-000000000001";
const q = async (s, p = []) => (await db.query(s, p)).rows;
const rpc = async (n, p = []) =>
  (
    await q(
      `select public.${n}(${p.map((_, i) => "$" + (i + 1)).join(",")}) value`,
      p,
    )
  )[0].value;
const login = async (id) => {
  await db.exec("reset role");
  await q("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ""]);
  await db.exec(id ? "set role authenticated" : "set role anon");
};
try {
  await db.exec(`create role authenticated;create role anon;create role service_role;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.email() returns text language sql stable as $$select 'fixture@example.test'::text$$;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');`);
  for (const file of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    if (file.startsWith("0012_") || file.startsWith("0032_")) continue;
    let source = readFileSync(new URL(file, dir), "utf8");
    if (file.startsWith("0003_follows") || file.startsWith("0008_"))
      source = source.split("insert into storage.buckets")[0];
    source = source
      .replace(/create extension if not exists pgcrypto;/gi, "")
      .replace(/do \$\$ begin alter publication[\s\S]*?end \$\$;/gi, "");
    try {
      await db.exec(source);
    } catch (e) {
      throw new Error(file + ": " + e.message);
    }
  }
  await db.exec(`grant usage on schema public,auth to authenticated,anon;grant select on all tables in schema public to authenticated;grant select,insert,update,delete on public.works,public.sessions,public.messages to authenticated;grant select,update on public.platform_config to authenticated;
 insert into auth.users(id,email) values('${a}','topshjtv@gmail.com'),('${b}','outsider@test');
 create or replace function auth.email() returns text language sql stable as $$select email from auth.users where id=auth.uid()$$;
 grant select on auth.users to authenticated;
 insert into works(id,creator_id,title,visibility) values('${work}','${a}','Simulation fixture','private');
 insert into sessions(id,user_id,work_id) values('${room}','${a}','${work}');
`);
  await login(a);
  const hashSetup='a'.repeat(64);
  const on=await rpc('set_information_features',[room,0,true,true]);
  assert.equal(on.knowledge_revision,1);
  await assert.rejects(()=>rpc('set_information_features',[room,0,false,false]));
  let ctx=await rpc('knowledge_context',[room]);
  assert.equal(ctx.entries.length,1);assert.equal(ctx.entries[0].source_hash,'seed');
  const patch={actors:[{name:'PC',pc:true,aliases:[]}],facts:[{id:'f1',kind:'pc',text:'PC는 요원이다',secret:true,subjects:['PC']}],knowledge:[{fact:'f1',actor:'PC',status:'knows',reason:'본인 신분',source:room,quote:'요원'}],scene:[]};
  assert.equal(await rpc('save_knowledge_event',[room,room,'seed',patch,hashSetup,1]),true);
  assert.deepEqual((await rpc('knowledge_context',[room])).entries[0].patch,patch);
  const first=(await q("insert into messages(session_id,role,content,turn_index) values($1,'assistant','A를 도서관에서 만났다.',1) returning *",[room]))[0];
  const second=(await q("insert into messages(session_id,role,content,turn_index) values($1,'assistant','A에게 정체를 말했다.',2) returning *",[room]))[0];
  ctx=await rpc('knowledge_context',[room]);
  const one=ctx.entries.find(e=>e.id===first.id),two=ctx.entries.find(e=>e.id===second.id);
  const empty={actors:[],facts:[],knowledge:[],scene:[]};
  await rpc('save_knowledge_event',[room,first.id,one.source_hash,empty,hashSetup,1]);
  await rpc('save_knowledge_event',[room,second.id,two.source_hash,empty,hashSetup,1]);
  assert.equal((await rpc('knowledge_context',[room,2])).entries.length,2,'reroll cannot see the replaced or future response');
  await q("update messages set content='도서관에서 B를 만났다.' where id=$1",[first.id]);
  ctx=await rpc('knowledge_context',[room]);
  assert.equal(ctx.entries[1].patch,null);assert.equal(ctx.entries[2].patch,null,'edits invalidate downstream knowledge');
  await assert.rejects(()=>rpc('save_knowledge_event',[room,second.id,two.source_hash,empty,hashSetup,1]));
  await assert.rejects(()=>q('update session_knowledge_events set patch=$1 where message_id=$2',[empty,room]));
  await rpc('record_knowledge_call',[room,'30000000-0000-0000-0000-000000000008','~deepseek/deepseek-flash-latest',100,20,0.01]);
  assert.equal((await rpc('knowledge_context',[room])).cost,0.01);
  await rpc('set_information_features',[room,1,false,false]);
  await assert.rejects(()=>rpc('save_knowledge_event',[room,room,'seed',patch,hashSetup,1]),'late background result rejected after OFF');
  await login(b);await assert.rejects(()=>rpc('knowledge_context',[room]));
  await assert.rejects(()=>rpc('knowledge_lease',[room,crypto.randomUUID(),'claim']));
  await assert.rejects(()=>rpc('set_information_features',[room,2,true,true]));
  await login(a);
  const keys=['system_prompt','theme_prompt','multichat_system_prompt','summary_prompt','semi_multichat_prompt','semi_sync_summary_prompt','work_combination_prompt','knowledge_config'];
  const raw=(await q('select * from platform_config where id=1'))[0];
  const previous=Object.fromEntries(keys.map(k=>[k,raw[k]]));
  const desired={...previous,system_prompt:'UPDATED SYSTEM',theme_prompt:'UPDATED THEME',knowledge_config:{detectorModel:'typesafe/jev-1.14',detectorPrompt:'# detect',model:'~deepseek/deepseek-flash-latest',maxOutputTokens:6000,recordPrompt:'# record',mainPrompt:'# main',reasoning:{effort:'off'}}};
  await rpc('save_admin_settings',[previous,desired,null]);
  assert.equal((await q('select knowledge_config from platform_config where id=1'))[0].knowledge_config.detectorModel,'typesafe/jev-1.14');
  await rpc('save_admin_settings',[previous,desired,null]);
  await assert.rejects(()=>rpc('save_admin_settings',[previous,{...desired,theme_prompt:'stale overwrite'},null]));
  await assert.rejects(()=>rpc('save_admin_settings',[desired,{...desired,summary_prompt:''},null]));
  await assert.rejects(()=>rpc('save_admin_settings',[desired,{...desired,theme_prompt:'must rollback'},'short']));
  assert.equal((await q('select theme_prompt from platform_config where id=1'))[0].theme_prompt,'UPDATED THEME');
  await login(b);await assert.rejects(()=>rpc('save_admin_settings',[desired,desired,null]));
  await login(null);await assert.rejects(()=>rpc('save_admin_settings',[desired,desired,null]));
  await login(b);await assert.rejects(()=>rpc('clear_information_table',[room,2]));
  await login(null);await assert.rejects(()=>rpc('clear_information_table',[room,2]));
  await login(a);
  await assert.rejects(()=>rpc('clear_information_table',[room,1]), 'stale revision cannot delete');
  await rpc('set_information_features',[room,2,true,true]);
  await rpc('save_knowledge_event',[room,room,'seed',patch,hashSetup,3]);
  const token=crypto.randomUUID();await rpc('knowledge_lease',[room,token,'claim']);
  const beforeMessages=await q('select id,content from messages where session_id=$1 order by id',[room]);
  const streaming=(await q("insert into messages(session_id,role,content,turn_index,generation_status) values($1,'assistant','partial',3,'streaming') returning id",[room]))[0];
  await assert.rejects(()=>rpc('clear_information_table',[room,3]), 'cannot clear during response generation');
  await q('delete from messages where id=$1',[streaming.id]);
  const cleared=await rpc('clear_information_table',[room,3]);
  assert.equal(cleared.knowledge_enabled,false);assert.equal(cleared.knowledge_revision,4);
  const clearedContext=await rpc('knowledge_context',[room]);
  assert.ok(clearedContext.entries.every(e=>e.patch===null));assert.equal(clearedContext.cost,0.01);
  assert.deepEqual(await q('select id,content from messages where session_id=$1 order by id',[room]),beforeMessages);
  assert.equal(await rpc('knowledge_lease',[room,token,'renew']),false,'old worker lease revoked');
  await assert.rejects(()=>rpc('save_knowledge_event',[room,room,'seed',patch,hashSetup,3]),'late worker cannot resurrect deleted table');
  await rpc('set_information_features',[room,4,true,true]);
  assert.equal(await rpc('save_knowledge_event',[room,room,'seed',patch,hashSetup,5]),true,'explicit re-enable can generate again');
  console.log('Information DB: seed/bootstrap, opt-in revisions, causal history, edit invalidation, OFF stale-write rejection, ownership, billing and atomic admin save verified.');
} finally { await db.close(); }
