import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const uri = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const themeUri = uri(compile(read('src/lib/theme.ts')));
const directivesUri = uri(compile(read('src/lib/themeDirectives.ts')).replace("'./theme'", JSON.stringify(themeUri)));
const { formatConversationText, conversationFilename, downloadConversationText } = await import(uri(
  compile(read('src/lib/chatExport.ts')).replace("'./themeDirectives'", JSON.stringify(directivesUri)),
));

// Execute the actual paginated reader and page handler without a production account.
const pageSource = read('src/pages/ChatPage.tsx');
const ast = ts.createSourceFile('ChatPage.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  let found;
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) && node.name?.text === name) ||
        (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === name))) found = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, `Missing declaration: ${name}`);
  return found;
}
const calls = [];
let rows = [], failPage = -1;
globalThis.__chatExportDb = { from(table) {
  assert.equal(table, 'messages');
  const request = { filters: {}, orders: [] };
  const chain = {
    select: () => chain,
    eq: (key, value) => { request.filters[key] = value; return chain; },
    order: (key, options) => { request.orders.push({ key, ...options }); return chain; },
    range: (from, to) => { Object.assign(request, { from, to }); return chain; },
    then: (resolve, reject) => Promise.resolve().then(() => {
      calls.push(request);
      if (request.from === failPage) return { data: null, error: new Error('offline') };
      const data = rows.filter(row => Object.entries(request.filters).every(([key, value]) => row[key] === value));
      data.sort((a, b) => {
        for (const { key, ascending } of request.orders) {
          const order = String(a[key]).localeCompare(String(b[key]));
          if (order) return ascending ? order : -order;
        }
        return 0;
      });
      return { data: data.slice(request.from, request.to + 1), error: null };
    }).then(resolve, reject),
  };
  return chain;
} };
const { fetchAllSessionMessages, orderMessagesByTurn, makeHandler } = await import(uri(compile(`
const supabase = globalThis.__chatExportDb;
${declaration('MESSAGE_FETCH_BATCH_SIZE')}
${declaration('fetchAllSessionMessages')}
${declaration('orderMessagesByTurn')}
export { fetchAllSessionMessages, orderMessagesByTurn };
export function makeHandler(context) {
  const recoverExpiredResponses = context.recoverExpiredResponses ?? (async () => 0);
  const {session,work,sending,exportInFlightRef,setExportingConversation,fetchAllSessionMessages,formatConversationText,orderMessagesByTurn,showToast,downloadConversationText,conversationFilename,addError,describeUnknownError} = context;
  ${declaration('exportConversation')}
  return exportConversation;
}
`)));
let id = 0;
const message = patch => ({
  id: String(++id), session_id: 'room', role: 'assistant', content: '', turn_index: 1,
  is_hidden: false, is_active_variant: true, generation_status: 'complete',
  created_at: '2026-10-17T07:00:00Z', ...patch,
});
const history = [
  message({ role: 'assistant', turn_index: 0, content: '첫 장면\n{{theme::정원:낮}}' }),
  message({ role: 'user', turn_index: 0, is_hidden: true, content: '숨겨진 설정' }),
  message({ role: 'system', turn_index: 0, content: '시스템 프롬프트' }),
  message({ role: 'user', content: '안녕\n두 번째 줄', is_summarized: true }),
  message({ content: '선택 안 된 답변', is_active_variant: false }),
  message({ role: 'user', turn_index: 2, content: '  들여쓰기 유지\n{{theme::keep}}', command_name: '계속' }),
  message({ turn_index: 2, content: '**두 번째 답변**\n\n![이미지](https://example.com/a.png)\n{{theme::정원:밤}}' }),
  // A selected reroll is created after the next turn, but belongs to the first turn.
  message({ content: '첫 답변\n{{theme::keep}}', created_at: '2026-10-17T09:00:00Z' }),
];
const original = JSON.stringify(history);
assert.equal(formatConversationText(orderMessagesByTurn(history)),
  '첫 장면\n\n\n1턴: 안녕\n두 번째 줄\n\n\n첫 답변\n\n\n2턴: /계속\n  들여쓰기 유지\n\n\n**두 번째 답변**\n\n![이미지](https://example.com/a.png)');
assert.equal(JSON.stringify(history), original, 'export must not mutate stored content or order');
assert.equal(formatConversationText([]), '');
assert.equal(formatConversationText([message({ content: '{{theme::keep}}' })]), '');
assert.equal(formatConversationText([message({ role: 'user', content: '' })]), '1턴: ');
assert.equal(formatConversationText([message({ content: '수신한 부분\n{{theme::정원:밤', generation_status: 'interrupted' })]), '수신한 부분');
assert.equal(formatConversationText([message({ content: '일반 중괄호 {', generation_status: 'interrupted' })]), '일반 중괄호 {');

rows = Array.from({ length: 1207 }, (_, index) => message({ id: String(index).padStart(5, '0'), turn_index: index + 1, content: `응답 ${index + 1}` })).reverse();
rows.push(message({ session_id: 'other-room', content: '다른 방의 비공개 대화' }));
const all = await fetchAllSessionMessages('room');
assert.equal(all.length, 1207);
assert.equal(all[0].content, '응답 1');
assert.equal(all.at(-1).content, '응답 1207');
assert.deepEqual(calls.map(({ from, to }) => [from, to]), [[0, 499], [500, 999], [1000, 1499]]);
assert.ok(!formatConversationText(all).includes('다른 방'));
rows = rows.slice(0, 1000);
assert.equal((await fetchAllSessionMessages('room')).length, 1000, 'exact page multiples finish after an empty page');
failPage = 500;
await assert.rejects(fetchAllSessionMessages('room'), /offline/, 'a failed page must not produce a truncated export');

const events = [], scheduled = [], downloads = [];
let downloadedBlob;
const createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL;
globalThis.document = {
  body: { appendChild: link => { events.push('append'); assert.equal(link.href, 'blob:export'); } },
  createElement: tag => {
    assert.equal(tag, 'a');
    return { click() { events.push('click'); downloads.push(this.download); }, remove() { events.push('remove'); } };
  },
};
globalThis.window = { setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); } };
URL.createObjectURL = blob => { downloadedBlob = blob; return 'blob:export'; };
URL.revokeObjectURL = url => { events.push(`revoke:${url}`); };
try {
  const filename = conversationFilename('제주도/수학여행:*?', new Date(2026, 9, 17, 16, 55, 3));
  assert.equal(filename, '제주도_수학여행____2026-10-17_16-55-03.txt');
  assert.ok(!/[<>:"/\\|?*\u0000-\u001f]/.test(filename));
  assert.ok(conversationFilename('...').startsWith('대화_'));
  downloadConversationText('1턴: 안녕\n\n반가워요', filename);
  const bytes = new Uint8Array(await downloadedBlob.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(await downloadedBlob.text(), '1턴: 안녕\n\n반가워요');
  assert.equal(downloadedBlob.type, 'text/plain;charset=utf-8');
  assert.deepEqual(events, ['append', 'click', 'remove']);
  assert.deepEqual(downloads, [filename]);
  assert.ok(scheduled[0].delay > 0);
  scheduled[0].callback();
  assert.equal(events.at(-1), 'revoke:blob:export');
} finally { URL.createObjectURL = createURL; URL.revokeObjectURL = revokeURL; }

const states = [], notices = [], errors = [], files = [];
let respond;
const context = {
  session: { id: 'room', title: '우리 대화' }, work: { title: '작품' }, sending: false,
  exportInFlightRef: { current: false }, setExportingConversation: value => states.push(value),
  fetchAllSessionMessages: sessionId => { assert.equal(sessionId, 'room'); return respond(); },
  formatConversationText, orderMessagesByTurn, conversationFilename,
  showToast: text => notices.push(text), downloadConversationText: (...args) => files.push(args),
  addError: text => errors.push(text), describeUnknownError: error => error.message,
};
const handler = makeHandler(context);
let resolve;
respond = () => new Promise(done => { resolve = done; });
const pending = handler();
await handler();
assert.deepEqual(states, [true], 'repeated clicks cannot start duplicate downloads');
resolve(history); await pending;
assert.equal(files.length, 1);
assert.ok(files[0][0].includes('2턴: /계속'));
assert.ok(files[0][1].startsWith('우리 대화_'));
assert.deepEqual(states, [true, false]);
respond = async () => { throw new Error('offline'); };
await handler();
assert.equal(errors.at(-1), '대화 추출 실패: offline');
assert.equal(context.exportInFlightRef.current, false);
assert.equal(files.length, 1, 'failed reads must not download partial files');
respond = async () => [];
await handler();
assert.equal(notices.at(-1), '추출할 대화가 없습니다.');
respond = async () => [message({ generation_status: 'streaming' })];
await handler();
assert.equal(notices.at(-1), '응답 생성이 끝난 뒤 추출해 주세요.');
await makeHandler({ ...context, sending: true })();
assert.equal(files.length, 1);
respond = async () => history;
await handler();
assert.equal(files.length, 2, 'exports can be retried after errors or empty history');
console.log('Chat export passed: full history over 1,000 rows, turn/reroll ordering, theme stripping, original text preservation, UTF-8 download, duplicate clicks and read failures.');
