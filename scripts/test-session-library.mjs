import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
const uri = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const compile = path => ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const libraryUri = uri(compile('src/lib/sessionLibrary.ts'));
const { sortLibrarySessions, folderPath, groupLibrarySessions, matchesSessionSearch, sessionsInLocation } = await import(libraryUri);
const sessions = [
  { id: 'a', title: '밤의 요코하마', work_id: 'one', is_archived: true, works: { title: '작품', thumbnail_url: 'https://example.test/thumbnail.png' }, personas: { name: '히나' } },
  { id: 'b', title: 'Tokyo NIGHT', work_id: 'two', is_archived: false, works: { title: '작품' }, personas: { name: ' 히나 ' } },
  { id: 'c', title: '미분류', work_id: 'one', is_archived: false, works: { title: '작품' }, personas: null },
];
assert.deepEqual(groupLibrarySessions(sessions, 'personas'), [{ id: '히나', name: '히나', count: 2 }]);
assert.equal(groupLibrarySessions([sessions[0], sessions[2]], 'personas')[0].count, 1, 'persona folder remains while one room uses it');
assert.deepEqual(groupLibrarySessions([sessions[2]], 'personas'), [], 'persona folder disappears when no rooms use it');
assert.deepEqual(groupLibrarySessions(sessions.map(session => ({ ...session, personas: null })), 'personas'), [], 'changing away from the persona removes its empty folder');
assert.equal(groupLibrarySessions(sessions, 'works').length, 2, 'same-title works are separate by work ID');
assert(matchesSessionSearch(sessions[0], '히나 요코하마'));
assert(matchesSessionSearch(sessions[1], 'ＴＯＫＹＯ night'));
assert(!matchesSessionSearch(sessions[2], '히나'));
assert.deepEqual(sessionsInLocation(sessions, { kind: 'bookmarks' }, []).map(s => s.id), ['a']);
assert.deepEqual(sessionsInLocation(sessions, { kind: 'persona', id: '히나' }, []).map(s => s.id), ['a', 'b']);
const custom = { id: 'f', name: '모험', session_folder_items: [{ session_id: 'b' }, { session_id: 'deleted' }] };
assert.deepEqual(sessionsInLocation(sessions, { kind: 'custom', id: 'f' }, [custom]).map(s => s.id), ['b']);

assert.deepEqual(sortLibrarySessions(sessions, { a: 1, b: 5, c: 0 }, 'turns-desc').map(item => item.id), ['b','a','c']);
assert.deepEqual(sortLibrarySessions(sessions, { a: 1, b: 5, c: 0 }, 'turns-asc').map(item => item.id), ['c','a','b']);
assert.equal(sortLibrarySessions(sessions, {}, 'latest'), sessions);
assert.deepEqual(sortLibrarySessions(sessions, { a: 0 }, 'turns-asc').map(item => item.id), ['a','b','c'], 'unloaded counts sort last');
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
  await db.exec(readFileSync(new URL('../supabase/migrations/20261125001852_nested_session_folders.sql', import.meta.url), 'utf8'));
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
  const child = '00000000-0000-0000-0000-000000000099';
  await query('insert into session_folders(id,user_id,name,parent_id) values($1,$2,$3,$4)', [child,owner,'하위',folder]);
  await assert.rejects(() => query('update session_folders set parent_id=$1 where id=$2',[child,folder]), /상위 경로/);
  await login(other);
  await assert.rejects(() => query('insert into session_folders(user_id,name,parent_id) values($1,$2,$3)',[other,'외부',folder]), /상위 폴더/);
  await login(owner);
  await query('delete from session_folders where id=$1',[child]);
  await save(folder, '빈 폴더', []);
  assert.equal((await query('select * from session_folder_items where folder_id=$1', [folder])).length, 0);
  await login(other);
  assert.equal((await query('select * from session_folders')).length, 0);
  assert.equal((await query('select * from session_folder_items')).length, 0);
  await assert.rejects(() => save(folder, '탈취', []), /row-level security/);
  await assert.rejects(() => query('insert into session_folder_items values($1,$2)', [folder, otherRoom]), /row-level security/);
  assert.equal((await query('delete from session_folders where id=$1 returning id', [folder])).length, 0);
  await login(owner);
  await query('insert into session_folders(id,user_id,name,parent_id) values($1,$2,$3,$4)', [child,owner,'하위',secondFolder]);
  await query('insert into session_folder_items values($1,$2)', [child,room]);
  await query('delete from session_folders where id=$1', [secondFolder]);
  assert.equal((await query('select * from session_folders where id=$1', [child])).length, 0, 'deleting a parent removes its subtree');
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
  react: hooks, '@/components/InterfaceIcon': empty, '@/components/ModernPageHeading': empty, '@/components/Friends': empty, '@/components/ConfirmDialog': empty, '@/components/SessionFolderDialog': empty, '@/components/SessionFolderPicker': empty, '@/lib/sessionLibrary': libraryUri,
  '@tanstack/react-query': uri(`export const useQueryClient=()=>({invalidateQueries:async value=>globalThis.__libraryInvalidated.push(value)});export const useQuery=args=>({data:args.queryKey[0]==='sessions'?globalThis.__librarySessions:args.queryKey[0]==='session-folders'?globalThis.__libraryFolders:args.queryKey[0]==='counts'?globalThis.__libraryCounts:[],isSuccess:true,isLoading:false,isError:false});`),
  'react-router-dom': uri(`export const Link=()=>null;export const useSearchParams=()=>[new URLSearchParams()];`),
  '@/lib/supabase': uri('export const supabase=globalThis.__libraryDB;'), '@/lib/sessionCounts': uri("export const fetchSessionConversationCounts=()=>({});export const sessionCountsKey=()=>['counts'];"),
  '@/lib/operationTiming': uri('export const measureOperation=(_,fn)=>fn();'), '@/hooks/useAuth': uri("export const useAuth=()=>({user:{id:'owner'}});"),
  '@/lib/toast': uri('export const showToast=()=>{};'), '@/lib/dialog': uri('export const showConfirmDialog=async()=>globalThis.__confirmDelete ?? false;'),
};
const source = compile('src/pages/SessionsPage.tsx').replace(/from\s+(['"])([^'"]+)\1/g, (_, q, p) => 'from ' + JSON.stringify(imports[p] ?? import.meta.resolve(p)));
const Page = (await import(uri(source))).default;
const render = () => { globalThis.__libraryUI.index = 0; return Page(); };
function nodes(node, predicate, out = []) { if (!node || typeof node !== 'object') return out; if (predicate(node)) out.push(node); for (const child of [node.props?.children].flat(Infinity)) nodes(child, predicate, out); return out; }
const label = node => node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : [node?.props?.children].flat(Infinity).map(label).join('');
const button = (tree, text) => nodes(tree, n => n.type === 'button' && label(n) === text)[0];
let tree = render();
assert.equal(nodes(tree, n => n.type === 'li').length, 3, 'bookmarked rooms remain active');
nodes(tree, n => n.type === 'select' && n.props['aria-label'] === '채팅방 정렬')[0].props.onChange({target:{value:'turns-desc'}}); tree = render();
assert.deepEqual(nodes(tree, n => n.type === 'li').map(item => item.key), ['b','a','c']);
nodes(tree, n => n.type === 'select')[0].props.onChange({target:{value:'latest'}}); tree = render();
button(tree, '보관함').props.onClick(); tree = render();
assert.equal(nodes(tree, n => n.props['aria-label'] === '폴더 삭제').length, 0, 'built-in folders have no delete control');
assert(button(tree, '폴더'), 'folder creation is available at the root');
assert(nodes(tree, n => n.type === 'button' && label(n).startsWith('작품별 보기'))[0].props.children.some(child => child?.props?.children?.props?.name === 'works'));
assert(nodes(tree, n => n.type === 'button' && label(n).startsWith('페르소나별 보기'))[0].props.children.some(child => child?.props?.children?.props?.name === 'my'));
nodes(tree, n => n.type === 'button' && label(n).startsWith('작품별 보기'))[0].props.onClick(); tree = render();
assert.equal(nodes(tree, n => n.type === 'img' && n.props.src === 'https://example.test/thumbnail.png').length, 1, 'work folder displays its thumbnail');
assert(nodes(tree, n => n.props?.name === 'folder').length > 0, 'missing thumbnails retain a folder icon');
button(tree, '보관함').props.onClick(); tree = render();
nodes(tree, n => n.type === 'button' && label(n).startsWith('페르소나별 보기'))[0].props.onClick(); tree = render();
assert.equal(nodes(tree, n => n.props['aria-label'] === '폴더 삭제').length, 0);
assert.equal(button(tree, '폴더'), undefined, 'built-in folders cannot contain custom folders');
assert(nodes(tree, n => n.type === 'button' && label(n).startsWith('히나2'))[0].props.children.some(child => child?.props?.children?.props?.name === 'my'), 'persona subfolder uses the person icon');
globalThis.__librarySessions = [sessions[2]]; tree = render();
assert(!nodes(tree, n => n.type === 'button' && label(n).startsWith('히나')).length, 'empty persona folder disappears from the UI after session refresh');
globalThis.__librarySessions = sessions; tree = render();
nodes(tree, n => n.type === 'button' && label(n).startsWith('히나2'))[0].props.onClick(); tree = render();
assert.equal(nodes(tree, n => n.type === 'li').length, 2);
assert.equal(nodes(tree, n => n.props['aria-label'] === '폴더 삭제').length, 0, 'automatic subfolders cannot be deleted');
assert.equal(button(tree, '폴더'), undefined, 'automatic subfolders cannot contain custom folders');
button(tree, '보관함').props.onClick(); tree = render();
nodes(tree, n => n.type === 'button' && label(n).startsWith('모험'))[0].props.onClick(); tree = render();
assert.equal(nodes(tree, n => n.props['aria-label'] === '폴더 삭제').length, 1);
assert(button(tree, '추가'), 'custom folders allow subfolder creation');
assert.equal(nodes(tree, n => n.type === 'li').length, 1);
button(tree, '보관함').props.onClick(); tree = render();
nodes(tree, n => n.type === 'button' && label(n).startsWith('북마크1'))[0].props.onClick(); tree = render();
assert.equal(nodes(tree, n => n.type === 'li').length, 1);
button(tree, '선택').props.onClick(); tree = render(); button(tree, '전체 선택').props.onClick(); tree = render();
await button(tree, '북마크 해제').props.onClick();
assert.deepEqual(calls.at(-1), { table: 'sessions', value: { is_archived: false }, ids: ['a'] });
tree = render(); button(tree, '활성').props.onClick(); tree = render();
nodes(tree, n => n.props['aria-label'] === '채팅방 검색')[0].props.onClick(); tree = render();
nodes(tree, n => n.type === 'input' && n.props.type === 'search')[0].props.onChange({ target: { value: '히나 요코하마' } }); tree = render();
assert.equal(nodes(tree, n => n.type === 'li').length, 1);
button(tree, '선택').props.onClick(); tree = render(); button(tree, '전체 선택').props.onClick(); tree = render();
assert(label(tree).includes('1개 선택됨'), 'select all applies only to search results');
assert(button(tree, '폴더에 추가'));
const beforeDelete = calls.length; await button(tree, '삭제하기').props.onClick(); assert.equal(calls.length, beforeDelete, 'cancelling the warning never deletes rooms');
button(tree, '취소').props.onClick(); tree = render();
button(tree, '선택').props.onClick(); tree = render(); button(tree, '전체 선택').props.onClick(); tree = render();
await button(tree, '북마크하기').props.onClick();
assert.deepEqual(calls.at(-1), { table: 'sessions', value: { is_archived: true }, ids: ['a'] });
assert(invalidated.some(key => key.queryKey[0] === 'sessions'));
console.log('Session library: grouping, search, retained bookmarks, folder editing, atomic saves, account isolation, cascade cleanup, protected built-ins, scoped bulk selection and bookmark UI passed');

// Folder paths distinguish nested destinations with matching names.
assert.deepEqual(folderPath({ id: 'child', parent_id: 'f', name: '하위' }, [custom]).map(item => item.name), ['모험', '하위']);
console.log('Nested folders, unified selection and delete cancellation passed');

let saved = false, closed = false;
globalThis.__libraryDB.from = table => ({ upsert: async (value, options) => { calls.push({ table, value, options }); return { error: null }; } });
const widgetImports = { react: hooks, '@/lib/sessionLibrary': libraryUri, '@/lib/supabase': uri('export const supabase=globalThis.__libraryDB;'), '@/lib/toast': uri('export const showToast=()=>{};') };
async function widget(file) { return (await import(uri(compile(file).replace(/from\s+(['"])([^'"]+)\1/g, (_, q, p) => 'from ' + JSON.stringify(widgetImports[p] ?? import.meta.resolve(p)))))).default; }
const Dialog = await widget('src/components/SessionFolderDialog.tsx');
globalThis.__libraryUI = { index: 0, values: [] };
const props = { parentId: 'f', userId: 'owner', onClose: () => { closed = true; }, onSaved: async () => { saved = true; } };
const renderWidget = (Component, input) => { globalThis.__libraryUI.index = 0; return Component(input); };
tree = renderWidget(Dialog, props);
assert.equal(nodes(tree, n => n.type === 'input').length, 1, 'folder creation only asks for a name');
nodes(tree, n => n.type === 'input')[0].props.onChange({ target: { value: '하위' } }); tree = renderWidget(Dialog, props);
nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }); await new Promise(r => setTimeout(r, 0));
assert(saved && closed); assert.equal(calls.at(-1).value.parent_id, 'f'); assert.equal(calls.at(-1).value.name, '하위');
const Picker = await widget('src/components/SessionFolderPicker.tsx');
globalThis.__libraryUI = { index: 0, values: [] }; saved = closed = false;
const pickerProps = { ...props, sessionIds: ['a', 'b'], folders: [custom, { id: 'child', name: '하위', parent_id: 'f' }], loading: false, failed: false, onRetry() {} };
tree = renderWidget(Picker, pickerProps); assert(label(tree).includes('모험 / 하위'));
nodes(tree, n => n.type === 'input' && n.props.value === 'child')[0].props.onChange(); tree = renderWidget(Picker, pickerProps);
nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }); await new Promise(r => setTimeout(r, 0));
assert(saved && closed); assert.deepEqual(calls.at(-1).value, [{ folder_id: 'child', session_id: 'a' }, { folder_id: 'child', session_id: 'b' }]);
assert.equal(calls.at(-1).options.ignoreDuplicates, true);
console.log('Name-only folder creation and nested destination picker with bulk idempotent membership passed');
