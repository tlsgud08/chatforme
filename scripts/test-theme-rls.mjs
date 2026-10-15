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
await db.exec(readFileSync(root+'supabase/migrations/20261014173500_fluid_chat_theme.sql','utf8'));
await db.exec(readFileSync(root+'supabase/migrations/20261015020249_day_night_work_themes.sql','utf8'));
await db.exec(readFileSync(root+'supabase/migrations/20261015022514_stale_day_night_branch_recovery.sql','utf8'));
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
// Fluid scene changes should never select a fixed tab, and a fixed tab must
// reject auto themes even when clients bypass the sidebar.
const fluidId='30000000-0000-0000-0000-000000000001';
const fixedId='30000000-0000-0000-0000-000000000002';
await db.query('insert into sessions(id,user_id,work_id,theme_override,theme_id,theme_variant,auto_theme_enabled) values($1,$2,$3,NULL,$4,$5,true)',[fluidId,a,w,shared,'light']);
await db.query('insert into sessions(id,user_id,work_id,theme_override,theme_variant,auto_theme_enabled) values($1,$2,$3,$4,$5,false)',[fixedId,a,w,'builtin','light']);
await deny('update sessions set auto_theme_enabled=true where id=$1',[fixedId]);
await deny('update sessions set theme_override=$1 where id=$2',['custom',fluidId]);
// An explicit global change switches the fluid scene variant everywhere,
// without changing its scene id, the fluid tab, or any fixed choice.
await db.query("update profiles set preferred_theme_mode='dark' where id=$1",[a]);
let state=(await db.query('select theme_override,theme_id,theme_variant,auto_theme_enabled from sessions where id=$1',[fluidId])).rows[0];
assert.deepEqual(state,{theme_override:null,theme_id:shared,theme_variant:'dark',auto_theme_enabled:true});
assert.equal((await db.query('select theme_variant from sessions where id=$1',[fixedId])).rows[0].theme_variant,'light');
await db.query('update sessions set auto_theme_enabled=false where id=$1',[fluidId]);
await db.query('update sessions set theme_override=$1,theme_variant=$2 where id=$3',['custom','light',fluidId]);
await db.query('update sessions set theme_override=NULL where id=$1',[fluidId]);
state=(await db.query('select theme_override,theme_id,theme_variant from sessions where id=$1',[fluidId])).rows[0];
assert.deepEqual(state,{theme_override:null,theme_id:shared,theme_variant:'light'},'fixed custom → fluid must preserve the exact scene');
await db.query('update sessions set auto_theme_enabled=true where id=$1',[fluidId]);
await db.query("update profiles set preferred_theme_mode='dark' where id=$1",[a]);
assert.equal((await db.query('select theme_variant from sessions where id=$1',[fluidId])).rows[0].theme_variant,'dark','global mode must sync even if selected already');
await login(b);
const unauthorizedFluid='30000000-0000-0000-0000-000000000003';
await deny('insert into sessions(id,user_id,work_id,theme_id,theme_variant) values($1,$2,$3,$4,$5)',[unauthorizedFluid,b,other,personal,'light']);
await login(a);
console.log('Fluid theme DB: preserved scene, globally synced variant, fixed auto lock, reference access and RLS OK');

// The existing two nullable palette slots also persist variant-neutral single
// themes. Editing their format must preserve references and requested modes.
const identityBefore=(await db.query('select id,owner_id,work_id from themes where id=$1',[shared])).rows[0];
const savedPalette=(await db.query('select dark_colors from themes where id=$1',[shared])).rows[0].dark_colors;
await db.query('update themes set light_colors=$1 where id=$2',[JSON.stringify({...basic,main:'#ffffff',mainText:'#000000'}),shared]);
assert.equal((await db.query('select light_colors is not null as dual from themes where id=$1',[shared])).rows[0].dual,true);
await db.query('update themes set light_colors=NULL where id=$1',[shared]);
const persisted=(await db.query('select id,owner_id,work_id,dark_colors,light_colors from themes where id=$1',[shared])).rows[0];
assert.deepEqual({id:persisted.id,owner_id:persisted.owner_id,work_id:persisted.work_id},identityBefore);
assert.deepEqual(persisted.dark_colors,savedPalette);
assert.equal(persisted.light_colors,null);
await db.query("update profiles set preferred_theme_mode='light' where id=$1",[a]);
const singleScene=(await db.query('select theme_id,theme_variant from sessions where id=$1',[fluidId])).rows[0];
assert.deepEqual(singleScene,{theme_id:shared,theme_variant:'light'},'global preference changes do not replace a single scene id');
assert.deepEqual((await db.query('select dark_colors from themes where id=$1',[shared])).rows[0].dark_colors,savedPalette,'global light preference cannot change a single palette');
await db.query('update themes set dark_colors=NULL,light_colors=$1 where id=$2',[JSON.stringify(savedPalette),shared]);
assert.deepEqual((await db.query('select light_colors from themes where id=$1',[shared])).rows[0].light_colors,savedPalette,'either legacy slot can store the same single palette');
console.log('Single theme DB: single/dual edits, unchanged identity/references/colors and independent global variant OK');
// A sidebar variant edit while the account uses a custom single theme must
// retain the global theme ID, and sync only fluid scenes (even legacy OFF ones).
const globalTheme='20000000-0000-0000-0000-000000000010';
await db.query('insert into themes(id,owner_id,work_id,name,light_colors) values($1,$2,NULL,$3,$4)',[globalTheme,a,'전역 단일',JSON.stringify(savedPalette)]);
await db.query("update profiles set preferred_theme_mode='custom',preferred_theme_id=$1,preferred_theme_variant='light' where id=$2",[globalTheme,a]);
await db.query('update sessions set auto_theme_enabled=false where id=$1',[fluidId]);
await db.query("update profiles set preferred_theme_variant='dark' where id=$1",[a]);
assert.deepEqual((await db.query('select preferred_theme_mode,preferred_theme_id,preferred_theme_variant from profiles where id=$1',[a])).rows[0],{preferred_theme_mode:'custom',preferred_theme_id:globalTheme,preferred_theme_variant:'dark'});
assert.deepEqual((await db.query('select theme_override,theme_id,theme_variant,auto_theme_enabled from sessions where id=$1',[fluidId])).rows[0],{theme_override:null,theme_id:shared,theme_variant:'dark',auto_theme_enabled:false});
assert.deepEqual((await db.query('select light_colors from themes where id=$1',[globalTheme])).rows[0].light_colors,savedPalette);
assert.equal((await db.query('select theme_variant from sessions where id=$1',[fixedId])).rows[0].theme_variant,'light');
// Actual automatic write: obsolete OFF flags do not block fluid updates, and
// the mode guard still prevents an in-flight response from touching fixed rooms.
assert.equal((await db.query("update sessions set theme_id=$1,theme_variant='dark' where id=$2 and user_id=$3 and theme_override is null returning id",[shared,fluidId,a])).rows.length,1);
assert.equal((await db.query("update sessions set theme_id=$1,theme_variant='dark' where id=$2 and user_id=$3 and theme_override is null returning id",[shared,fixedId,a])).rows.length,0);
console.log('Custom global variant sync: unchanged IDs/colors, legacy OFF fluid writes and fixed-mode race guard OK');
console.log('Postgres migration and RLS checks: private read/write isolation, scope immutability, reference guards, deletion reset and admin-only config OK');
// Upgrade a populated schema and preserve every existing palette and checkbox.
const upgradeDual=(await db.query('insert into themes(owner_id,work_id,name,dark_colors,light_colors,day_night_enabled) values($1,$2,$3,$4,$4,true) returning id',[a,w,'기존 체크 복수',JSON.stringify(basic)])).rows[0].id;
await db.exec('reset role');
const upgradeSnapshot=(await db.query('select id,dark_colors,light_colors,day_night_enabled from themes order by id')).rows;
await db.exec(readFileSync(root+'supabase/migrations/20261015043406_time_theme_conditions.sql','utf8'));
assert.deepEqual((await db.query('select id,dark_colors,light_colors,day_night_enabled from themes order by id')).rows,upgradeSnapshot);
await login(a);
// Simulate the old dark-preference client leaving the flag ON before upgrading.
await db.query('update sessions set theme_day_night_enabled=true where id in ($1,$2)',[fluidId,fixedId]);
const roomSnapshot=(await db.query('select id,theme_id,theme_variant,theme_override from sessions order by id')).rows;
await db.exec('reset role');
await db.exec(readFileSync(root+'supabase/migrations/20261015045732_disable_night_mode_for_dark_preference.sql','utf8'));
assert.deepEqual((await db.query('select id,theme_id,theme_variant,theme_override from sessions order by id')).rows,roomSnapshot,'upgrade clears time state without changing any selected palette or fixed mode');
await login(a);
assert.equal((await db.query('select count(*)::int as n from sessions where user_id=$1 and theme_day_night_enabled',[a])).rows[0].n,0);
// Defaults preserve all old rooms/themes. Night is a separate scene column.
assert.equal((await db.query('select theme_day_night_enabled from sessions where id=$1',[fluidId])).rows[0].theme_day_night_enabled,false);
const singleColors=(await db.query('select dark_colors,light_colors from themes where id=$1',[shared])).rows[0];
await db.query('update themes set day_night_enabled=true where id=$1',[shared]);
assert.deepEqual((await db.query('select dark_colors,light_colors from themes where id=$1',[shared])).rows[0],singleColors,'time-only condition accepts a single palette without adding or changing colors');
await deny('update themes set day_night_enabled=true where id=$1',[globalTheme]);
await db.query('update themes set dark_colors=$1,day_night_enabled=false where id=$2',[JSON.stringify(basic),shared]);
await db.query("update profiles set preferred_theme_variant='light' where id=$1",[a]);
await db.query("update sessions set theme_day_night_enabled=true,theme_period='night' where id=$1",[fluidId]);
assert.deepEqual((await db.query('select theme_variant,theme_period from sessions where id=$1',[fluidId])).rows[0],{theme_variant:'light',theme_period:'night'});
await deny("update sessions set theme_period='sunset' where id=$1",[fluidId]);
await db.query("update profiles set preferred_theme_variant='light' where id=$1",[a]);
assert.deepEqual((await db.query('select theme_variant,theme_period from sessions where id=$1',[fluidId])).rows[0],{theme_variant:'light',theme_period:'night'},'preference sync never destroys night scene state');
await db.query('update sessions set theme_day_night_enabled=false where id=$1',[fluidId]);
assert.equal((await db.query('select theme_period from sessions where id=$1',[fluidId])).rows[0].theme_period,null);
await db.query("update sessions set theme_day_night_enabled=true,theme_period='night' where id=$1",[fluidId]);
await db.query("update sessions set theme_override='custom',auto_theme_enabled=false where id=$1",[fluidId]);
assert.equal((await db.query('select theme_period from sessions where id=$1',[fluidId])).rows[0].theme_period,null,'fixed choices clear an old night override');
await db.query('update sessions set theme_override=null where id=$1',[fluidId]);
await db.query("update sessions set theme_period='night' where id=$1",[fluidId]);
await login(c);
assert.equal((await db.query('update themes set day_night_enabled=false where id=$1 returning id',[shared])).rows.length,0,'theme option follows existing work edit permissions');
await login(a);
// Every dual theme supports night state, regardless of its time-only condition.
await db.query('update themes set day_night_enabled=false where id=$1',[shared]);
const staleBranch=(await db.query("insert into sessions(id,user_id,work_id,theme_id,theme_variant,theme_day_night_enabled,theme_period) values(gen_random_uuid(),$1,$2,$3,'light',true,'night') returning theme_id,theme_period",[a,w,shared])).rows[0];
assert.deepEqual(staleBranch,{theme_id:shared,theme_period:'night'},'unchecked dual themes retain their night state when branching');
await db.query('update themes set dark_colors=NULL,day_night_enabled=true where id=$1',[shared]);
const singleBranch=(await db.query("insert into sessions(id,user_id,work_id,theme_id,theme_variant,theme_day_night_enabled,theme_period) values(gen_random_uuid(),$1,$2,$3,'light',true,'night') returning theme_id,theme_period",[a,w,shared])).rows[0];
assert.deepEqual(singleBranch,{theme_id:shared,theme_period:null},'converting a theme to single cannot block a cached night branch');
console.log('Branch recovery SQL: unchecked dual retains time; checked single retains palette and discards stale period OK');

// The global preference change disables every room for this account, including
// fixed rooms and fluid rooms with no palette metadata, but never another user.
const emptyRoom=(await db.query('insert into sessions(id,user_id,work_id,theme_day_night_enabled) values(gen_random_uuid(),$1,$2,true) returning id',[a,w])).rows[0].id;
await db.query("update sessions set theme_day_night_enabled=true,theme_period='night',theme_id=$1 where id=$2",[upgradeDual,fluidId]);
await db.query('update sessions set theme_day_night_enabled=true where id=$1',[fixedId]);
const fixedBefore=(await db.query('select theme_id,theme_variant,theme_override from sessions where id=$1',[fixedId])).rows[0];
await login(b);
const otherRoom=(await db.query("insert into sessions(id,user_id,work_id,theme_id,theme_day_night_enabled,theme_period) values(gen_random_uuid(),$1,$2,$3,true,'night') returning id",[b,w,upgradeDual])).rows[0].id;
await login(a);
await db.query("update profiles set preferred_theme_variant='dark' where id=$1",[a]);
assert.equal((await db.query('select count(*)::int as n from sessions where user_id=$1 and (theme_day_night_enabled or theme_period is not null)',[a])).rows[0].n,0);
assert.deepEqual((await db.query('select theme_id,theme_variant,theme_override from sessions where id=$1',[fixedId])).rows[0],fixedBefore);
assert.equal((await db.query('select theme_variant from sessions where id=$1',[emptyRoom])).rows[0].theme_variant,null);
assert.equal((await db.query('select preferred_theme_id from profiles where id=$1',[a])).rows[0].preferred_theme_id,globalTheme);
await db.query("update sessions set theme_day_night_enabled=true,theme_period='night' where id=$1",[fluidId]);
assert.deepEqual((await db.query('select theme_day_night_enabled,theme_period from sessions where id=$1',[fluidId])).rows[0],{theme_day_night_enabled:false,theme_period:null},'cached dark-preference writes are forced OFF');
const darkBranch=(await db.query("insert into sessions(id,user_id,work_id,theme_id,theme_day_night_enabled,theme_period) values(gen_random_uuid(),$1,$2,$3,true,'night') returning theme_day_night_enabled,theme_period",[a,w,upgradeDual])).rows[0];
assert.deepEqual(darkBranch,{theme_day_night_enabled:false,theme_period:null});
await db.query("update profiles set preferred_theme_variant='light' where id=$1",[a]);
assert.equal((await db.query('select count(*)::int as n from sessions where user_id=$1 and theme_day_night_enabled',[a])).rows[0].n,0,'returning to light never restores ON');
await db.query('update sessions set theme_day_night_enabled=true where id=$1',[fluidId]);
assert.equal((await db.query('select theme_day_night_enabled from sessions where id=$1',[fluidId])).rows[0].theme_day_night_enabled,true,'light preference can explicitly enable again');
await db.query("update profiles set preferred_theme_mode='dark' where id=$1",[a]);
assert.equal((await db.query('select theme_day_night_enabled from sessions where id=$1',[fluidId])).rows[0].theme_day_night_enabled,false,'builtin dark overrides the stored light variant');
await login(b);
assert.deepEqual((await db.query('select theme_day_night_enabled,theme_period from sessions where id=$1',[otherRoom])).rows[0],{theme_day_night_enabled:true,theme_period:'night'});
await login(a);
console.log('Dark preference: migration cleanup, account-wide OFF, fixed palettes, empty rooms, stale writes/branches, light return and cross-user isolation OK');

await db.query('delete from themes where id=$1',[shared]);
assert.equal((await db.query('select theme_period from sessions where id=$1',[fluidId])).rows[0].theme_period,null,'theme deletion clears scene period without blocking FK recovery');
console.log('Day/night SQL: default OFF, work-only condition accepts single/dual, all dual period guards, preference sync, fixed/deleted cleanup and RLS OK');
await db.close();
