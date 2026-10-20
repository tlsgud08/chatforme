import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/interfacePreference.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { loadInterfaceDesign, saveInterfaceDesign, subscribeInterfaceDesign } = await import(
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

  storage.set('inuchat.interface-design.v1', 'unknown-version');
  assert.equal(loadInterfaceDesign(), 'modern');
  browser.localStorage.getItem = () => { throw new Error('storage disabled'); };
  assert.equal(loadInterfaceDesign(), 'modern', 'unavailable storage does not break first render');
  browser.localStorage.setItem = () => { throw new Error('storage full'); };
  assert.equal(saveInterfaceDesign('legacy'), false, 'failed persistence is reported rather than silently changing the layout');
  console.log('Interface preference: persistence, theme isolation, tab synchronization, cleanup and blocked storage OK');
} finally {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
