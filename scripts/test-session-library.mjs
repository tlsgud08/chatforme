import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
const uri = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const compile = path => ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const libraryUri = uri(compile('src/lib/sessionLibrary.ts'));
const { groupLibrarySessions, matchesSessionSearch, sessionsInLocation } = await import(libraryUri);
const sessions = [
  { id: 'a', title: '밤의 요코하마', work_id: 'one', is_archived: true, works: { title: '작품', thumbnail_url: 'https://example.test/thumbnail.png' }, personas: { name: '히나' } },
  { id: 'b', title: 'Tokyo NIGHT', work_id: 'two', is_archived: false, works: { title: '작품' }, personas: { name: ' 히나 ' } },
  { id: 'c', title: '미분류', work_id: 'one', is_archived: false, works: { title: '작품' }, personas: null },
];
assert.deepEqual(groupLibrarySessions(sessions, 'personas'), [{ id: '히나', name: '히나', count: 2 }]);
assert.equal(groupLibrarySessions(sessions, 'works').length, 2, 'same-title works are separate by work ID');
assert(matchesSessionSearch(sessions[0], '히나 요코하마'));
assert(matchesSessionSearch(sessions[1], 'ＴＯＫＹＯ night'));
assert(!matchesSessionSearch(sessions[2], '히나'));
assert.deepEqual(sessionsInLocation(sessions, { kind: 'bookmarks' }, []).map(s => s.id), ['a']);
assert.deepEqual(sessionsInLocation(sessions, { kind: 'persona', id: '히나' }, []).map(s => s.id), ['a', 'b']);
const custom = { id: 'f', name: '모험', session_folder_items: [{ session_id: 'b' }, { session_id: 'deleted' }] };
assert.deepEqual(sessionsInLocation(sessions, { kind: 'custom', id: 'f' }, [custom]).map(s => s.id), ['b']);

const db = new PGlite();
const [owner, other, room, otherRoom, multi, folder, secondFolder] = Array.from({ length: 7 }, (_, i) => '00000000-0000-0000-0000-' + String(i + 1).padStart(12, '0'));
const query = async (sql, args = []) => (await db.query(sql, args)).rows;
const login = async id => { await db.exec('reset role'); await query("select set_config('request.jwt.claim.sub',$1,false)", [id]); await db.exec('set role authenticated'); };
const save = (id, name, rooms) => query('select save_session_folder($1,$2,$3)', [id, name, rooms]);
try {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table auth.users(id uuid primary key);
    create table sessions(id uuid primary key,user_id uuid,multichat_room_id uuid,is_archived boolean default false);
    alter table sessions enable row level security;
    create policy own_sessions on sessions to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
    grant usage on schema public,auth to authenticated,anon;
    grant select,insert,update,delete on sessions to authenticated;`);
  await query('insert into auth.users values($1),($2)', [owner, other]);
  await query('insert into sessions(id,user_id,is_archived) values($1,$2,true),($3,$4,false)', [room, owner, otherRoom, other]);
  await query('insert into sessions values($1,$2,$1,false)', [multi, owner]);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261124235204_session_library_folders.sql', import.meta.url), 'utf8'));
  await login(owner);
  await save(folder, '  모험  ', [room, room]);
  assert.equal((await query('select name from session_folders'))[0].name, '모험');
  assert.equal((await query('select * from session_folder_items')).length, 1);
  assert.equal((await query('select is_archived from sessions where id=$1', [room]))[0].is_archived, true, 'legacy archives retain bookmarks');
  await assert.rejects(() => save(folder, 'invalid', [otherRoom]), /선택한 채팅방/);
  await assert.rejects(() => save(folder, 'invalid', [multi]), /선택한 채팅방/);
  await assert.rejects(() => save(folder, '  ', []), /폴더 이름/);
  assert.equal((await query('select name from session_folders'))[0].name, '모험', 'failed edits preserve both name and membership');
  await save(secondFolder, '겹치는 분류', [room]);
  await save(folder, '빈 폴더', []);
  assert.equal((await query('select * from session_folder_items where folder_id=$1', [folder])).length, 0);
  await login(other);
  assert.equal((await query('select * from session_folders')).length, 0);
  assert.equal((await query('select * from session_folder_items')).length, 0);
  await assert.rejects(() => save(folder, '탈취', []), /row-level security/);
  await assert.rejects(() => query('insert into session_folder_items values($1,$2)', [folder, otherRoom]), /row-level security/);
  assert.equal((await query('delete from session_folders where id=$1 returning id', [folder])).length, 0);
  await login(owner);
  await query('delete from session_folders where id=$1', [secondFolder]);
  assert.equal((await query('select * from sessions where id=$1', [room])).length, 1, 'folder deletion preserves the room');
  await save(folder, '자동 정리', [room]);
  await query('delete from sessions where id=$1', [room]);
  assert.equal((await query('select * from session_folder_items')).length, 0, 'room deletion cascades membership only');
  await db.exec('reset role; set role anon');
  await assert.rejects(() => save(folder, 'anonymous', []), /permission denied/);
} finally { await db.close(); }

// Render and operate the actual page with deterministic hooks and database fixtures.
const hooks = uri(`export const useEffect=()=>{};export function useState(initial){const s=globalThis.__libraryUI,i=s.index++;if(!(i in s.values))s.values[i]=typeof initial==='function'?initial():initial;return[s.values[i],v=>s.values[i]=typeof v==='function'?v(s.values[i]):v]}`);
const empty = uri('export default ()=>null;export const FriendActivityStrip=()=>null;');
const calls = [], invalidated = [];
globalThis.__libraryUI = { index: 0, values: [] };
globalThis.__librarySessions = sessions;
globalThis.__libraryFolders = [custom];
globalThis.__libraryCounts = { a: 1, b: 5, c: 0 };
globalThis.__libraryDB = { from(table) { const chain = { update(value) { calls.push({ table, value }); return chain; }, in(key, ids) { calls.at(-1).ids = ids; return chain; }, select: async () => ({ data: calls.at(-1).ids.map(id => ({ id })), error: null }) }; return chain; } };
globalThis.__libraryInvalidated = invalidated;
const imports = {
  react: hooks, '@/components/InterfaceIcon': empty, '@/components/ModernPageHeading': empty, '@/components/Friends': empty, '@/components/ConfirmDialog': empty, '@/components/SessionFolderDialog': empty, '@/lib/sessionLibrary': libraryUri,
  '@tanstack/react-query': uri(`export const useQueryClient=()=>({invalidateQueries:async value=>globalThis.__libraryInvalidated.push(value)});export const useQuery=args=>({data:args.queryKey[0]==='sessions'?globalThis.__librarySessions:args.queryKey[0]==='session-folders'?globalThis.__libraryFolders:args.queryKey[0]==='counts'?globalThis.__libraryCounts:[],isSuccess:true,isLoading:false,isError:false});`),
  'react-router-dom': uri(`export const Link=()=>null;export const useSearchParams=()=>[new URLSearchParams()];`),
  '@/lib/supabase': uri('export const supabase=globalThis.__libraryDB;'), '@/lib/sessionCounts': uri("export const fetchSessionConversationCounts=()=>({});export const sessionCountsKey=()=>['counts'];"),
  '@/lib/operationTiming': uri('export const measureOperation=(_,fn)=>fn();'), '@/hooks/useAuth': uri("export const useAuth=()=>({user:{id:'owner'}});"),
  '@/lib/toast': uri('export const showToast=()=>{};'), '@/lib/dialog': uri('export const showConfirmDialog=async()=>false;'),
};
const source = compile('src/pages/SessionsPage.tsx').replace(/from\s+(['"])([^'"]+)\1/g, (_, q, p) => 'from ' + JSON.stringify(imports[p] ?? import.meta.resolve(p)));
const Page = (await import(uri(source))).default;
const render = () => { globalThis.__libraryUI.index = 0; return Page(); };
function nodes(node, predicate, out = []) { if (!node || typeof node !== 'object') return out; if (predicate(node)) out.push(node); for (const child of [node.props?.children].flat(Infinity)) nodes(child, predicate, out); return out; }
const label = node => node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : [node?.props?.children].flat(Infinity).map(label).join('');
const button = (tree, text) => nodes(tree, n => n.type === 'button' && label(n) === text)[0];
let tree = render();
assert.equal(nodes(tree, n => n.type === 'li').length, 3, 'bookmarked rooms remain active');
button(tree, '보관함').props.onClick(); tree = render();
assert.equal(nodes(tree, n => n.props['aria-label'] === '폴더 삭제').length, 0, 'built-in folders have no delete control');
assert(nodes(tree, n => n.type === 'button' && label(n).startsWith('작품별 보기'))[0].props.children.some(child => child?.props?.children?.props?.name === 'works'));
assert(nodes(tree, n => n.type === 'button' && label(n).startsWith('페르소나별 보기'))[0].props.children.some(child => child?.props?.children?.props?.name === 'my'));
nodes(tree, n => n.type === 'button' && label(n).startsWith('작품별 보기'))[0].props.onClick(); tree = render();
assert.equal(nodes(tree, n => n.type === 'img' && n.props.src === 'https://example.test/thumbnail.png').length, 1, 'work folder displays its thumbnail');
assert(nodes(tree, n => n.props?.name === 'folder').length > 0, 'missing thumbnails retain a folder icon');
button(tree, '보관함').props.onClick(); tree = render();
nodes(tree, n => n.type === 'button' && label(n).startsWith('페르소나별 보기'))[0].props.onClick(); tree = render();
assert.equal(nodes(tree, n => n.props['aria-label'] === '폴더 삭제').length, 0);
nodes(tree, n => n.type === 'button' && label(n).startsWith('히나2'))[0].props.onClick(); tree = render();
assert.equal(nodes(tree, n => n.type === 'li').length, 2);
assert.equal(nodes(tree, n => n.props['aria-label'] === '폴더 삭제').length, 0, 'automatic subfolders cannot be deleted');
button(tree, '보관함').props.onClick(); tree = render();
nodes(tree, n => n.type === 'button' && label(n).startsWith('모험'))[0].props.onClick(); tree = render();
assert.equal(nodes(tree, n => n.props['aria-label'] === '폴더 삭제').length, 1);
assert.equal(nodes(tree, n => n.type === 'li').length, 1);
button(tree, '보관함').props.onClick(); tree = render();
nodes(tree, n => n.type === 'button' && label(n).startsWith('북마크1'))[0].props.onClick(); tree = render();
assert.equal(nodes(tree, n => n.type === 'li').length, 1);
button(tree, '북마크 해제').props.onClick(); tree = render(); button(tree, '전체 선택').props.onClick(); tree = render();
await button(tree, '북마크 해제').props.onClick();
assert.deepEqual(calls.at(-1), { table: 'sessions', value: { is_archived: false }, ids: ['a'] });
tree = render(); button(tree, '활성').props.onClick(); tree = render();
nodes(tree, n => n.props['aria-label'] === '채팅방 검색')[0].props.onClick(); tree = render();
nodes(tree, n => n.type === 'input' && n.props.type === 'search')[0].props.onChange({ target: { value: '히나 요코하마' } }); tree = render();
assert.equal(nodes(tree, n => n.type === 'li').length, 1);
button(tree, '삭제').props.onClick(); tree = render(); button(tree, '전체 선택').props.onClick(); tree = render();
assert(label(tree).includes('1개 선택됨'), 'select all applies only to search results');
button(tree, '취소').props.onClick(); tree = render();
button(tree, '북마크').props.onClick(); tree = render(); button(tree, '전체 선택').props.onClick(); tree = render();
await button(tree, '북마크하기').props.onClick();
assert.deepEqual(calls.at(-1), { table: 'sessions', value: { is_archived: true }, ids: ['a'] });
assert(invalidated.some(key => key.queryKey[0] === 'sessions'));
console.log('Session library: grouping, search, retained bookmarks, folder editing, atomic saves, account isolation, cascade cleanup, protected built-ins, scoped bulk selection and bookmark UI passed');

// Exercise the actual folder editor: selections outside search results persist.
let closed = false, saved = false, rpcFailure = false;
globalThis.__libraryDB.rpc = async (name, args) => { calls.push({ name, args }); return { error: rpcFailure ? { message: 'temporary failure' } : null }; };
const dialogImports = { react: hooks, '@/lib/sessionLibrary': libraryUri, '@/lib/supabase': uri('export const supabase=globalThis.__libraryDB;'), '@/lib/toast': uri('export const showToast=()=>{};') };
const dialogSource = compile('src/components/SessionFolderDialog.tsx').replace(/from\s+(['"])([^'"]+)\1/g, (_, q, p) => 'from ' + JSON.stringify(dialogImports[p] ?? import.meta.resolve(p)));
const Dialog = (await import(uri(dialogSource))).default;
globalThis.__libraryUI = { index: 0, values: [] };
const dialogProps = { folder: { ...custom, session_folder_items: [{ session_id: 'b' }] }, sessions, onClose: () => { closed = true; }, onSaved: async () => { saved = true; } };
const renderDialog = () => { globalThis.__libraryUI.index = 0; return Dialog(dialogProps); };
tree = renderDialog();
nodes(tree, n => n.props['aria-label'] === '폴더 이름')[0].props.onChange({ target: { value: '수정된 폴더' } });
nodes(tree, n => n.props['aria-label'] === '폴더에 추가할 채팅방 검색')[0].props.onChange({ target: { value: '요코하마' } }); tree = renderDialog();
assert.equal(nodes(tree, n => n.props.type === 'checkbox').length, 1);
nodes(tree, n => n.props.type === 'checkbox')[0].props.onChange(); tree = renderDialog();
nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }); await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(calls.at(-1), { name: 'save_session_folder', args: { target_folder: 'f', folder_name: '수정된 폴더', session_ids: ['b', 'a'] } });
assert(saved && closed);
saved = closed = false; rpcFailure = true;
tree = renderDialog(); nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }); await new Promise(resolve => setTimeout(resolve, 0));
assert(!saved && !closed, 'failed saves preserve the editor and chosen rooms');
tree = renderDialog(); assert.equal(button(tree, '저장').props.disabled, false);
console.log('Folder editor: searched room selection preserves other memberships, atomic RPC arguments, success close and retryable save errors passed');
