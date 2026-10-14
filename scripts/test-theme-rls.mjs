import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const db=new PGlite();
const root=fileURLToPath(new URL('../',import.meta.url));
await db.exec(`
create role authenticated; create role anon;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.email() returns text language sql stable as $$select current_setting('request.jwt.claim.email',true)$$;
create table profiles(id uuid primary key);
create table works(id uuid primary key,creator_id uuid);
create table sessions(id uuid primary key,user_id uuid,work_id uuid);
create table commands(id uuid primary key,owner_id uuid,name text,is_published boolean default false);
create table platform_config(id integer primary key,system_prompt text);
alter table platform_config enable row level security;
create policy config_select_all on platform_config for select using(true);
create policy config_update_admin on platform_config for update using(auth.email()='admin@example.test');
insert into platform_config values(1,'original');
create function can_edit_work(w uuid) returns boolean language sql stable security definer as $$select exists(select 1 from works where id=w and creator_id=auth.uid())$$;
grant usage on schema public,auth to authenticated,anon;
grant select,insert,update,delete on all tables in schema public to authenticated,anon;
`);
for(const name of ['0039','0040']){
 // Locate by prefix to follow the repository's established filenames.
 const file=readdirSync(root+'supabase/migrations').find(f=>f.startsWith(name.slice(0,4)));
 await db.exec(readFileSync(root+'supabase/migrations/'+file,'utf8'));
}
await db.exec(readFileSync(root+'supabase/migrations/20261014031245_automatic_work_themes.sql','utf8'));
await db.exec(readFileSync(root+'supabase/migrations/20261014034744_theme_secondary_text.sql','utf8'));
await db.exec(readFileSync(root+'supabase/migrations/20261014044407_theme_secondary_opacity.sql','utf8'));
await db.exec('grant select,insert,update,delete on all tables in schema public to authenticated,anon;');
const a='00000000-0000-0000-0000-000000000001',b='00000000-0000-0000-0000-000000000002',c='00000000-0000-0000-0000-000000000003';
const w='10000000-0000-0000-0000-000000000001',other='10000000-0000-0000-0000-000000000002';
const shared='20000000-0000-0000-0000-000000000001',personal='20000000-0000-0000-0000-000000000002';
await db.exec(`insert into profiles values('${a}'),('${b}'),('${c}');insert into works values('${w}','${a}'),('${other}','${a}');`);
const palette=JSON.stringify({accent:'#123456',accentText:'#ffffff',main:'#000000',mainText:'#ffffff'});
async function login(id,email='user@example.test'){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.email',$2,false)",[id,email]);await db.exec('set role authenticated');}
async function deny(sql,params=[]){await assert.rejects(()=>db.query(sql,params));}
await login(a);
await db.query('insert into themes(id,owner_id,work_id,name,dark_colors) values($1,$2,$3,$4,$5)',[shared,a,w,'공용',palette]);
await login(b);
await db.query('insert into themes(id,owner_id,work_id,name,dark_colors,work_shared,ai_prompt) values($1,$2,$3,$4,$5,false,$6)',[personal,b,w,'개인',palette,'밤']);
await deny('insert into themes(owner_id,work_id,name,dark_colors,work_shared) values($1,$2,$3,$4,true)',[b,w,'공용 불가',palette]);
assert.equal((await db.query('select * from themes')).rows.length,2);
await deny('update themes set work_shared=true where id=$1',[personal]);
await deny('update themes set work_id=$1 where id=$2',[other,personal]);
await db.query('insert into sessions(id,user_id,work_id,theme_override,theme_id) values(gen_random_uuid(),$1,$2,$3,$4)',[b,w,'custom',personal]);
await deny('insert into sessions(id,user_id,work_id,theme_override,theme_id) values(gen_random_uuid(),$1,$2,$3,$4)',[b,other,'custom',personal]);
await login(c);
assert.equal((await db.query('select * from themes')).rows.length,1);
assert.equal((await db.query('update themes set ai_prompt=$1 where id=$2 returning id',['steal',personal])).rows.length,0);
await deny('insert into sessions(id,user_id,work_id,theme_override,theme_id) values(gen_random_uuid(),$1,$2,$3,$4)',[c,w,'custom',personal]);
assert.equal((await db.query("update platform_config set theme_prompt='hacked' where id=1 returning id")).rows.length,0);
await login(a);
assert.equal((await db.query('select * from themes')).rows.length,1,'work creator cannot see private user theme');
await deny('update works set default_theme_id=$1 where id=$2',[personal,w]);
await login(a,'admin@example.test');
assert.equal((await db.query("update platform_config set theme_prompt='admin rules' where id=1 returning id")).rows.length,1);
await login(b);
await db.query('delete from themes where id=$1',[personal]);
const session=(await db.query('select theme_override,theme_id from sessions')).rows[0];
assert.deepEqual(session,{theme_override:null,theme_id:null});
await db.exec('reset role;set role anon');
assert.equal((await db.query('select * from themes')).rows.length,1);
await deny("insert into themes(owner_id,work_id,name,dark_colors) values($1,$2,'anon',$3)",[a,w,palette]);
await db.exec('reset role');
const basic={accent:'#123456',accentText:'#ffffff',main:'#000000',mainText:'#ffffff'};
for(const [p,expected] of [[basic,true],[{...basic,secondaryText:'#aa33ee',softenSecondaryText:false},true],[{...basic,secondaryText:'pink'},false],[{...basic,secondaryText:null},false],[{...basic,softenSecondaryText:'false'},false],...([0,35,65,100].map(value=>[{...basic,secondaryTextOpacity:value},true])),...([-1,101,3.5,'65',null].map(value=>[{...basic,secondaryTextOpacity:value},false]))]){
  const {rows}=await db.query('select public.valid_theme_palette($1::jsonb) as valid',[JSON.stringify(p)]);
  assert.equal(rows[0].valid,expected);
}
await login(a);
await db.query('update themes set dark_colors=$1 where id=$2',[JSON.stringify({...basic,secondaryText:'#aa33ee',softenSecondaryText:false}),shared]);
await deny('update themes set dark_colors=$1 where id=$2',[JSON.stringify({...basic,softenSecondaryText:'false'}),shared]);
await db.query('update themes set dark_colors=$1 where id=$2',[JSON.stringify({...basic,secondaryTextOpacity:35}),shared]);
await deny('update themes set dark_colors=$1 where id=$2',[JSON.stringify({...basic,secondaryTextOpacity:101}),shared]);
console.log('Optional secondary colors and toggle: Postgres validator and actual theme UPDATE allow/deny OK');
console.log('Postgres migration and RLS checks: private read/write isolation, scope immutability, reference guards, deletion reset and admin-only config OK');
await db.close();
