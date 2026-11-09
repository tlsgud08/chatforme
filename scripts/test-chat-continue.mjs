import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import vm from 'node:vm';

// Reuse the actual send handler + OpenRouter HTTP fixture, changing only its
// in-memory dialogue/persistence boundaries. No model or production writes.
const harness = readFileSync(new URL('./test-reroll.mjs', import.meta.url), 'utf8');
const boundary = harness.indexOf("  const legacy = 'original input");
assert(boundary > 0);
const file = new URL(`./.continue-fixture-${crypto.randomUUID()}.mjs`, import.meta.url);
const checks = `
  const counts = [], restored = [];
  env.setTotalUserTurnCount = count => counts.push(count);
  env.cacheSessionCount = (_client, _owner, _room, count) => counts.push(count);
  env.setInput = update => restored.push(typeof update === 'function' ? update('') : update);
  env.beginResponse = async args => {
    saved.push(['begin', structuredClone(args)]);
    return { draft: { id: 'draft', generation_status: 'streaming', turn_index: args.requested_turn },
      userMessage: args.user_message_id ? { id: args.user_message_id, role: 'user', content: args.user_text } : null };
  };
  const initialBegin = env.beginResponse;
  const answered = [...history];
  const unanswered = history.slice(0, -1);
  // A deliberately stale, short screen must not decide whether to insert a user.
  env.messages = [history.at(-1)];
  let fresh = answered;
  env.generationContext = async () => ({ messages: fresh, summary: '', summaryLastTurn: 0, contextHash: 'context' });
  env.input = String.fromCharCode(32,32,10,9);
  await send();
  let claim = saved.findLast(row => row[0] === 'begin')[1];
  assert.equal(claim.user_text, '*이어서 계속 진행*'); assert(claim.user_message_id);
  assert.equal(claim.requested_turn, 3); assert.deepEqual(counts, [3,3]);
  assert.equal(bodies.at(-1).messages.at(-1).content, '*이어서 계속 진행*');

  fresh = [...unanswered, { ...history.at(-1), id: 'inactive', is_active_variant: false }, { ...history.at(-1), id: 'hidden', is_hidden: true }];
  counts.length = 0; env.input = ''; await send();
  claim = saved.findLast(row => row[0] === 'begin')[1];
  assert.equal(claim.reuse_user_message, 'user2'); assert.equal(claim.user_message_id, null);
  assert.equal(claim.requested_turn, 2); assert.deepEqual(counts, [], 'reused users never increment the chat/session cache');
  const body = JSON.stringify(bodies.at(-1).messages);
  assert.equal(body.split('original input').length-1, 1, 'the reused user is present only once in the actual payload');
  assert(body.includes('[Selected Command /scene]') && body.includes('original command'));

  fresh = unanswered; env.input = '새 메시지'; counts.length = 0; await send();
  claim = saved.findLast(row => row[0] === 'begin')[1];
  assert.equal(claim.user_text, '새 메시지'); assert(claim.user_message_id); assert(!claim.reuse_user_message);
  assert.deepEqual(counts, [3,3], 'typed messages still add exactly one user');
  env.input = ''; env.selectedCommand = { id: 'selected', name: '행동', prompt: 'COMMAND ONLY' }; await send();
  claim = saved.findLast(row => row[0] === 'begin')[1];
  assert.equal(claim.user_text, ''); assert.equal(claim.user_command_name, '행동'); assert(claim.user_message_id);
  assert(!claim.reuse_user_message, 'an explicit selected command takes precedence over Continue');

  env.selectedCommand = null; fresh = answered; counts.length = 0;
  const before = bodies.length;
  await Promise.all([send(), send()]);
  assert.equal(bodies.length, before+1, 'same-render double clicks still make exactly one request');
  env.beginResponse = async () => { throw Error('server migration required'); };
  const beforeFailure = bodies.length; counts.length = 0; await send();
  assert.equal(bodies.length, beforeFailure); assert.deepEqual(counts, []);
  env.beginResponse = initialBegin;
  assert.deepEqual(errors.filter(text => !text.includes('server migration required')), []);
  console.log('Continue: real HTTP/send flow, visible editable user payload, fresh dialogue, no duplicated user/command, same-turn reply, exact count/cache increments, command-only precedence, double-click and pre-model failures passed.');
} finally { globalThis.fetch = originalFetch; delete globalThis.window; delete globalThis.sessionStorage; await server.close(); }
`;
try { writeFileSync(file, harness.slice(0, boundary) + checks); execFileSync(process.execPath, [file.pathname], { stdio: 'inherit' }); }
finally { unlinkSync(file); }

const source = readFileSync(new URL('../src/pages/ChatPage.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let label, content;
function visit(node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'button') {
    const aria = node.openingElement.attributes.properties.find(attr => attr.name?.getText(ast) === 'aria-label');
    if (aria?.initializer?.getText(ast).includes("'메시지 전송'")) {
      label = aria.initializer.expression.getText(ast);
      content = node.children.find(ts.isJsxExpression)?.expression?.getText(ast);
    }
  }
  ts.forEachChild(node, visit);
}
visit(ast); assert(label && content);
for (const [input, selectedCommand, expected] of [['',null,'계속'],[' \n ',null,'계속'],['문자',null,'전송'],['',{id:'command'},'전송']]) {
  assert.equal(vm.runInNewContext(label,{input,selectedCommand}), expected === '계속' ? '계속' : '메시지 전송');
  assert.equal(vm.runInNewContext(content,{input,selectedCommand}), expected);
}
assert(!source.includes('indigo-'), 'command bubbles/editors do not retain a fixed purple palette');
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
assert.match(css, /textarea:focus-visible\s*\{\s*outline: 2px solid rgb\(var\(--color-brand\)\)/);
assert.match(css, /:root\[data-theme='custom'\] textarea:focus-visible/);
console.log('Continue labels and theme accents: actual button expressions, whitespace/command states and variable-based textarea/command styles passed.');
