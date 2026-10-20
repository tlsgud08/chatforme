import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/interfacePreference.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const {
  loadInterfaceDesign, saveInterfaceDesign, subscribeInterfaceDesign,
  loadAppWidthLimited, saveAppWidthLimited, loadChatWidthLimited, saveChatWidthLimited, subscribeInterfaceWidth,
} = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')
);
const originalWindow = globalThis.window;
const storage = new Map([['inuchat.theme', 'custom']]);
const browser = new EventTarget();
browser.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};
globalThis.window = browser;

try {
  assert.equal(loadInterfaceDesign(), 'modern');
  let changes = 0;
  const unsubscribe = subscribeInterfaceDesign(() => changes++);
  assert.equal(saveInterfaceDesign('legacy'), true);
  assert.equal(changes, 1, 'same-tab subscribers see a saved layout immediately');
  assert.equal(loadInterfaceDesign(), 'legacy', 'a new reader restores the legacy choice');
  assert.equal(storage.get('inuchat.theme'), 'custom', 'layout changes never overwrite the color theme');

  function storageChanged(key) {
    browser.dispatchEvent(Object.assign(new Event('storage'), { key }));
  }
  storageChanged('unrelated-setting');
  assert.equal(changes, 1, 'unrelated storage events cannot rerender the interface');
  storageChanged('inuchat.interface-design.v1');
  storageChanged(null);
  assert.equal(changes, 3, 'another tab changing or clearing preferences updates the current tab');
  unsubscribe();
  saveInterfaceDesign('modern');
  storageChanged(null);
  assert.equal(changes, 3, 'unmounted subscribers are removed');

  assert.equal(loadAppWidthLimited(), false, 'the whole interface is responsive by default');
  assert.equal(loadChatWidthLimited(), true, 'chat messages are limited to 450px by default');
  let widthChanges = 0;
  const stopWidth = subscribeInterfaceWidth(() => widthChanges++);
  assert.equal(saveAppWidthLimited(true), true);
  assert.equal(widthChanges, 1, 'changing the whole-screen limit notifies the current tab');
  assert.equal(loadAppWidthLimited(), true);
  assert.equal(loadChatWidthLimited(), true, 'the whole-screen setting does not overwrite the message setting');
  assert.equal(saveChatWidthLimited(false), true);
  assert.equal(widthChanges, 2);
  assert.equal(loadChatWidthLimited(), false, 'a saved false overrides the enabled message default');
  assert.equal(loadAppWidthLimited(), true);
  saveInterfaceDesign('legacy');
  assert.equal(widthChanges, 2, 'design changes do not fire width notifications');
  assert.equal(loadAppWidthLimited(), true, 'switching to legacy preserves the modern width preferences');
  assert.equal(loadChatWidthLimited(), false);
  saveInterfaceDesign('modern');
  assert.equal(loadChatWidthLimited(), false, 'returning to modern restores the saved message choice');
  saveAppWidthLimited(false);
  saveChatWidthLimited(true);
  assert.equal(loadAppWidthLimited(), false, 'a saved false overrides a previous whole-screen limit');
  assert.equal(loadChatWidthLimited(), true);
  const beforeStorage = widthChanges;
  storageChanged('unrelated-setting');
  storageChanged('inuchat.interface-design.v1');
  assert.equal(widthChanges, beforeStorage, 'width subscribers ignore unrelated preferences');
  storage.set('inuchat.interface-app-width-450.v1', 'true');
  storageChanged('inuchat.interface-app-width-450.v1');
  assert.equal(loadAppWidthLimited(), true, 'another tab can update the whole-screen limit');
  storage.set('inuchat.interface-chat-width-450.v1', 'false');
  storageChanged('inuchat.interface-chat-width-450.v1');
  assert.equal(loadChatWidthLimited(), false, 'another tab can update the message limit independently');
  storage.delete('inuchat.interface-app-width-450.v1');
  storage.delete('inuchat.interface-chat-width-450.v1');
  storageChanged(null);
  assert.equal(widthChanges, beforeStorage + 3);
  assert.equal(loadAppWidthLimited(), false, 'clearing storage restores the whole-screen default');
  assert.equal(loadChatWidthLimited(), true, 'clearing storage restores the message default');
  stopWidth();
  const afterStop = widthChanges;
  saveChatWidthLimited(false);
  storageChanged(null);
  assert.equal(widthChanges, afterStop, 'unmounted width subscribers are removed');
  storage.set('inuchat.interface-app-width-450.v1', 'invalid');
  storage.set('inuchat.interface-chat-width-450.v1', 'invalid');
  assert.equal(loadAppWidthLimited(), false);
  assert.equal(loadChatWidthLimited(), true, 'invalid stored data uses the documented defaults');
  assert.equal(storage.get('inuchat.theme'), 'custom', 'neither width option changes the color theme');

  storage.set('inuchat.interface-design.v1', 'unknown-version');
  assert.equal(loadInterfaceDesign(), 'modern');
  browser.localStorage.getItem = () => { throw new Error('storage disabled'); };
  assert.equal(loadInterfaceDesign(), 'modern', 'unavailable storage does not break first render');
  assert.equal(loadAppWidthLimited(), false);
  assert.equal(loadChatWidthLimited(), true);
  browser.localStorage.setItem = () => { throw new Error('storage full'); };
  assert.equal(saveInterfaceDesign('legacy'), false, 'failed persistence is reported rather than silently changing the layout');
  let failedWidthEvents = 0;
  const stopFailedWidth = subscribeInterfaceWidth(() => failedWidthEvents++);
  assert.equal(saveAppWidthLimited(true), false);
  assert.equal(saveChatWidthLimited(false), false);
  assert.equal(failedWidthEvents, 0, 'failed saves do not notify readers of an unpersisted width');
  stopFailedWidth();
  console.log('Interface preference: design and independent 450px defaults, persistence, theme isolation, tab synchronization, cleanup and blocked storage OK');
} finally {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
