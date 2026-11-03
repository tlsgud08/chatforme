import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/responseHeartbeat.ts', import.meta.url), 'utf8').replace(/^import .*$/gm, '');
const compiled = ts.transpileModule(source.replace('export function', 'function'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
let tick, cleared = 0, calls = [], resolveRequest;
const rpc = (_name, args) => ({ abortSignal(signal) {
  calls.push({ args, signal });
  return new Promise(resolve => { resolveRequest = resolve; });
} });
const { startResponseHeartbeat } = vm.runInNewContext(compiled + '\n({startResponseHeartbeat})', {
  supabase: { rpc }, AbortController, AbortSignal,
  setInterval(fn, ms) { assert.equal(ms, 20_000); tick = fn; return 1; },
  clearInterval() { cleared++; },
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const owner = new AbortController();
const stop = startResponseHeartbeat('room', 'draft', owner);
assert.equal(calls.length, 1, 'register liveness before tokens arrive');
tick(); tick();
assert.equal(calls.length, 1, 'only one heartbeat request may be in flight');
resolveRequest({ data: true, error: null }); await flush();
tick(); assert.equal(calls.length, 2);
resolveRequest({ data: null, error: { message: 'offline' } }); await flush();
assert.equal(owner.signal.aborted, false, 'transient DB failure preserves model output');
tick(); assert.equal(calls.length, 3);
resolveRequest({ data: false, error: null }); await flush();
assert.equal(owner.signal.aborted, true, 'server-recovered draft stops the stale owner');
tick(); assert.equal(calls.length, 3);
stop(); assert.equal(cleared, 1);

const other = new AbortController();
const stopPending = startResponseHeartbeat('other-room', 'other-draft', other);
const pending = calls.at(-1);
stopPending(); assert.equal(pending.signal.aborted, true, 'cleanup cancels a hanging heartbeat');
resolveRequest({ data: false, error: null }); await flush();
assert.equal(other.signal.aborted, false, 'late replies cannot abort a finished generation');
tick(); assert.equal(calls.length, 4);
console.log('Response heartbeat: silent reasoning, serialized renewals, transient errors, lease loss, cancellation and late reply cleanup passed');
