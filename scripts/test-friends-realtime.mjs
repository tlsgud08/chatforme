import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { RealtimeClient } from '@supabase/supabase-js';

const source = readFileSync(new URL('../src/lib/friendRealtime.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { subscribeToFriendChanges } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const original = { setTimeout, clearTimeout, setInterval, clearInterval, now: Date.now, window: globalThis.window, document: globalThis.document };
let now = 0, serial = 0;
const timers = new Map();
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function advance(ms) {
  const target = now + ms;
  for (;;) {
    const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!next) break;
    const [id, timer] = next; now = timer.at;
    if (timer.interval) timer.at += timer.interval; else timers.delete(id);
    timer.callback(); await flush();
  }
  now = target; await flush();
}
globalThis.setTimeout = (callback, delay = 0) => { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
globalThis.setInterval = (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: now + delay, interval: delay }); return id; };
globalThis.clearInterval = id => timers.delete(id);
Date.now = () => now;
const window = globalThis.window = new EventTarget(), document = globalThis.document = new EventTarget();
document.visibilityState = 'visible';
const realtime = new RealtimeClient('ws://127.0.0.1:1/realtime/v1', { params: { apikey: 'fixture' } });
const records = new Map(), created = [];
const client = {
  channel(topic) {
    // Use the real SDK's topic lookup and asynchronous remove/teardown. Only
    // transport acknowledgements are controlled, so the old race is reproduced.
    const channel = realtime.channel(topic);
    if (!records.has(channel)) {
      const record = { handlers: [], leave: defer(), status: null, removed: false };
      records.set(channel, record); created.push(channel);
      const on = channel.on.bind(channel);
      channel.on = (type, filter, callback) => { record.handlers.push({ filter, callback }); return on(type, filter, callback); };
      channel.subscribe = callback => { record.status = callback; channel.state = 'joined'; return channel; };
      channel.unsubscribe = () => { record.removed = true; channel.state = 'leaving'; return record.leave.promise; };
    }
    return channel;
  },
  removeChannel: channel => realtime.removeChannel(channel),
};
const status = (channel, value) => records.get(channel).status?.(value);
const event = (channel, table = 'friend_activity_signals') => {
  for (const handler of records.get(channel).handlers) if (handler.filter.table === table) handler.callback({ eventType: 'UPDATE' });
};
async function finishLeave(channel) {
  // RealtimeChannel's onClose hook calls this SDK method after a server close.
  realtime._remove(channel); status(channel, 'CLOSED'); records.get(channel).leave.resolve('ok'); await flush();
}
let stop;
try {
  const old = client.channel('old-friends-topic'); old.subscribe(() => {});
  const removing = client.removeChannel(old);
  assert.equal(client.channel('old-friends-topic'), old, 'the real SDK reuses a channel while its unsubscribe is pending');
  await finishLeave(old); await removing;
  assert.equal(realtime.getChannels().length, 0, 'the old pattern loses its replacement when teardown finishes');

  let reads = 0, model = 'offline', displayed = '', block;
  const refresh = async () => { reads++; const pending = block; block = undefined; if (pending) await pending.promise; displayed = model; };
  stop = subscribeToFriendChanges(client, 'owner', [], refresh);
  const initial = created.at(-1); status(initial, 'SUBSCRIBED'); await advance(100);
  assert.equal(displayed, 'offline');
  stop(); // Initial friend snapshot adds a friend before the old leave finishes.
  stop = subscribeToFriendChanges(client, 'owner', ['peer'], refresh);
  const current = created.at(-1);
  assert.notEqual(current, initial); assert.notEqual(current.topic, initial.topic);
  assert.ok(records.get(current).handlers.some(row => row.filter.filter === 'user_id=in.(owner,peer)'));
  status(current, 'SUBSCRIBED'); await finishLeave(initial); await advance(100);
  assert.ok(realtime.getChannels().includes(current), 'late removal of the old subscription preserves the replacement');

  for (const value of ['online', 'playing:work-a', 'away:work-a', 'offline:last-work-a']) {
    model = value; event(current); await advance(100);
    assert.equal(displayed, value, 'status/work changes refresh without a page reload');
  }

  const beforeBurst = reads, pending = block = defer();
  for (let i = 0; i < 50; i++) { event(current); await advance(20); }
  assert.equal(reads, beforeBurst + 1, 'a continuous event stream starts a read instead of postponing it');
  pending.resolve(); await flush(); await advance(100);
  assert.equal(reads, beforeBurst + 2, 'slow reads coalesce notifications into one follow-up');

  model = 'missed-event'; await advance(15_100);
  assert.equal(displayed, model, 'visible pages recover a dropped event without reloading');
  document.visibilityState = 'hidden';
  const hiddenReads = reads; await advance(60_000);
  assert.equal(reads, hiddenReads, 'background pages do not poll');
  model = 'returned-to-tab'; document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); await advance(100);
  assert.equal(displayed, model, 'returning to the page catches up immediately');

  let activeChannel = current;
  for (const failure of ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']) {
    const previous = activeChannel;
    status(previous, failure); await advance(1000);
    activeChannel = created.at(-1); assert.notEqual(activeChannel, previous, `${failure} reconnects automatically`);
    model = `recovered:${failure}`; status(activeChannel, 'SUBSCRIBED'); await finishLeave(previous); await advance(100);
    assert.equal(displayed, model, 'reconnecting catches missed changes');
    assert.ok(realtime.getChannels().includes(activeChannel));
    const beforeStale = reads; event(previous); status(previous, 'CHANNEL_ERROR'); await advance(100);
    assert.equal(reads, beforeStale, 'old-channel callbacks cannot refresh or reconnect');
  }

  const beforeSDKRecovery = created.length;
  status(activeChannel, 'CHANNEL_ERROR'); await advance(100); status(activeChannel, 'SUBSCRIBED'); await advance(1000);
  assert.equal(created.length, beforeSDKRecovery, 'the SDK recovering first cancels the application retry');
  status(activeChannel, 'CHANNEL_ERROR'); window.dispatchEvent(new Event('online'));
  const restored = created.at(-1); assert.notEqual(restored, activeChannel, 'network return reconnects immediately');
  status(restored, 'SUBSCRIBED'); await finishLeave(activeChannel); await advance(100);

  stop(); const oldOwner = restored;
  let otherReads = 0;
  stop = subscribeToFriendChanges(client, 'other-account', [], async () => { otherReads++; });
  const other = created.at(-1); status(other, 'SUBSCRIBED'); await finishLeave(oldOwner); await advance(100);
  const afterSwitch = reads; event(oldOwner); status(oldOwner, 'CHANNEL_ERROR'); await advance(100);
  assert.equal(reads, afterSwitch, 'account changes ignore old requests and callbacks');
  const beforeCleanup = otherReads; stop(); stop = undefined;
  event(other); status(other, 'CHANNEL_ERROR'); await advance(60_000);
  assert.equal(otherReads, beforeCleanup, 'cleanup clears polling, reconnects and deferred refreshes');
  await finishLeave(other);
  assert.equal(realtime.getChannels().length, 0);

  let offlineReads = 0;
  stop = subscribeToFriendChanges(client, 'offline-account', [], async () => { offlineReads++; });
  await advance(5200);
  assert.ok(offlineReads >= 2, 'a socket that never subscribes still gets bounded automatic refreshes');
  const waiting = created.at(-1); status(waiting, 'CHANNEL_ERROR'); stop(); stop = undefined;
  const beforeDisposedRetry = created.length; await advance(60_000);
  assert.equal(created.length, beforeDisposedRetry, 'unmount cancels a pending reconnect');
  await finishLeave(waiting);
  console.log('Friends realtime: real SDK unsubscribe race reproduced/fixed, status/work changes, bounded event coalescing, lost-event recovery, background/foreground, all reconnect states, late callbacks and account cleanup passed');
} finally {
  stop?.();
  for (const record of records.values()) record.leave.resolve('ok');
  await flush(); await realtime.disconnect();
  timers.clear();
  globalThis.setTimeout = original.setTimeout; globalThis.clearTimeout = original.clearTimeout;
  globalThis.setInterval = original.setInterval; globalThis.clearInterval = original.clearInterval;
  Date.now = original.now;
  if (original.window === undefined) delete globalThis.window; else globalThis.window = original.window;
  if (original.document === undefined) delete globalThis.document; else globalThis.document = original.document;
}
