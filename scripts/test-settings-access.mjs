import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite(), dir = new URL('../supabase/migrations/', import.meta.url);
const a='00000000-0000-0000-0000-000000000001', b='00000000-0000-0000-0000-000000000002', c='00000000-0000-0000-0000-000000000003';
const work='10000000-0000-0000-0000-000000000001';
const q=async(sql,args=[])=>(await db.query(sql,args)).rows;
const rpc=async(name,args=[])=> (await q(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args))[0]?.value;
async function login(id) {
  await db.exec('reset role');await q("select set_config('request.jwt.claim.sub',$1,false),set_config('test.email',$2,false)",[id??'',id===a?'topshjtv@gmail.com':'member@test']);
  await db.exec(id?'set role authenticated':'set role anon');
}
try {
  await db.exec(`create role authenticated;create role anon;create role service_role;create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.email() returns text language sql stable as $$select current_setting('test.email',true)$$;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');`);
  for (const file of readdirSync(dir).filter(file=>file.endsWith('.sql')).sort()) {
    if(file.startsWith('0012_')||file.startsWith('0032_'))continue;
    let source=readFileSync(new URL(file,dir),'utf8');
    if(file.startsWith('0003_follows')||file.startsWith('0008_'))source=source.split('insert into storage.buckets')[0];
    source=source.replace(/create extension if not exists pgcrypto;/gi,'').replace(/do \$\$ begin alter publication[\s\S]*?end \$\$;/gi,'');
    if(file.endsWith('_delegated_settings_access.sql'))await db.exec(`
      create table private.settings_password_fixture(value text);
      create function public.set_signup_master_password(new_password text) returns void language plpgsql security definer set search_path=private,public as $$
      begin if auth.email() is distinct from 'topshjtv@gmail.com' then raise exception 'administrator only';end if;
      insert into private.settings_password_fixture values(new_password);end $$;
      revoke all on function public.set_signup_master_password(text) from public,anon;grant execute on function public.set_signup_master_password(text) to authenticated;`);
    try { await db.exec(source); } catch(error) { throw Error(file+': '+error.message); }
  }
  await db.exec(`grant usage on schema public,auth to authenticated,anon;
    grant select,insert,update,delete on all tables in schema public to authenticated;
    revoke update on public.settings_admins from authenticated;
    insert into auth.users(id,email) values('${a}','topshjtv@gmail.com'),('${b}','member@test'),('${c}','third@test');`);
  await login(b);assert.equal(await rpc('is_settings_admin'),false);
  await assert.rejects(()=>q('insert into settings_admins(user_id,granted_by) values($1,$1)',[b]));
  await login(null);await assert.rejects(()=>rpc('is_settings_admin'));await assert.rejects(()=>q('select * from settings_admins'));
  await login(a);assert.equal(await rpc('is_settings_admin'),true);
  await assert.rejects(()=>q('insert into settings_admins(user_id,granted_by) values($1,$2)',[b,c]),/row-level security/,'grantor cannot be forged');
  await q('insert into settings_admins(user_id,granted_by) values($1,$2),($3,$2)',[b,a,c]);
  await q("insert into works(id,creator_id,title,visibility) values($1,$2,'Private work','private')",[work,a]);
  const room=await rpc('create_session_with_start',[work,null,null]);
  const fields=['system_prompt','theme_prompt','multichat_system_prompt','summary_prompt','semi_multichat_prompt','semi_sync_summary_prompt','work_combination_prompt','knowledge_config'];
  const row=(await q('select * from platform_config where id=1'))[0];
  const before=Object.fromEntries(fields.map(key=>[key,row[key]]));
  const desired={...before,system_prompt:'DELEGATED SYSTEM',knowledge_config:{model:'fixture',recordPrompt:'record',mainPrompt:'main',maxOutputTokens:6000}};
  await login(b);assert.equal(await rpc('is_settings_admin'),true);assert.equal(await rpc('is_app_admin'),false,'delegation never grants unrelated administrator powers');
  assert.deepEqual((await q('select user_id from settings_admins')).map(row=>row.user_id),[b],'member cannot list other grants');
  await assert.rejects(()=>q('insert into settings_admins(user_id,granted_by) values($1,$2)',[a,b]));
  assert.deepEqual(await q('delete from settings_admins where user_id=$1 returning user_id',[c]),[],'delegates cannot revoke others');
  assert.deepEqual(await q('delete from settings_admins where user_id=$1 returning user_id',[b]),[],'delegates cannot modify access management');
  assert.deepEqual(await q('select id from works where id=$1',[work]),[]);
  assert.deepEqual(await q('select id from sessions where id=$1',[room]),[]);
  assert.equal(await rpc('save_admin_settings',[before,desired,'new password']),true);
  assert.equal((await q('select system_prompt from platform_config where id=1'))[0].system_prompt,'DELEGATED SYSTEM');
  await assert.rejects(()=>rpc('save_admin_settings',[before,{...desired,system_prompt:'STALE'},null]),/변경/);
  assert.equal(await rpc('save_global_summary_prompt',[before.summary_prompt,'DELEGATED SUMMARY']),true);
  assert.equal(await rpc('save_semi_multichat_prompt',[before.semi_multichat_prompt,'DELEGATED SYNC']),true);
  assert.equal(await rpc('save_semi_sync_summary_prompt',[before.semi_sync_summary_prompt,'DELEGATED EXPORT']),true);
  await login(a);await q('delete from settings_admins where user_id=$1',[b]);
  await login(b);assert.equal(await rpc('is_settings_admin'),false,'revocation applies immediately to existing sessions');
  await assert.rejects(()=>rpc('save_admin_settings',[desired,desired,null]));
  await assert.rejects(()=>rpc('set_signup_master_password',['unauthorized password']));
  assert.deepEqual(await q("update platform_config set system_prompt='REVOKED' where id=1 returning id"),[]);
  await db.exec('reset role');assert.equal((await q('select count(*)::int count from private.settings_password_fixture'))[0].count,1);
  assert.equal((await q("select relrowsecurity from pg_class where oid='public.settings_admins'::regclass"))[0].relrowsecurity,true);
  console.log('Settings access DB: founder-only grants/revocation, own-only role visibility, no privilege escalation/private work/chat access, delegated atomic save/password, legacy editors, stale writes and immediate revocation passed.');
} finally { await db.close(); }
