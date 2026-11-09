import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/imageCache.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { clearImageCaches } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
const remaining = new Set([
  'chat-markdown-images-v0', 'chat-markdown-images-v1', 'work-thumbnails-v1', 'work-thumbnails-v2',
  'workbox-precache-v2-app', 'api-responses', 'unrelated-images',
]);
const deleted = [];
const storage = {
  keys: async () => [...remaining],
  delete: async (name) => { deleted.push(name); return remaining.delete(name); },
};
Object.defineProperty(globalThis, 'caches', { configurable: true, value: storage });

try {
  await clearImageCaches();
  assert.equal(deleted.length, 4, 'both image caches and their obsolete versions are cleared');
  assert.deepEqual([...remaining], ['workbox-precache-v2-app', 'api-responses', 'unrelated-images'],
    'app assets and unrelated caches are preserved');
  await clearImageCaches();
  assert.equal(deleted.length, 4, 'clearing an already empty image cache succeeds without deleting other data');

  storage.keys = async () => ['chat-markdown-images-v1', 'work-thumbnails-v1'];
  storage.delete = async (name) => {
    deleted.push(name);
    if (name === 'chat-markdown-images-v1') throw new Error('storage blocked');
    return true;
  };
  await assert.rejects(clearImageCaches(), /deletion failed/, 'partial failure is reported');
  assert.deepEqual(deleted.slice(-2), ['chat-markdown-images-v1', 'work-thumbnails-v1'],
    'one failed deletion does not skip the other image cache');

  storage.delete = async () => false;
  await clearImageCaches(); // Another tab may have already removed the cache.

  storage.keys = async () => { throw new Error('storage access denied'); };
  await assert.rejects(clearImageCaches(), /storage access denied/, 'failed enumeration never reports success');

  Object.defineProperty(globalThis, 'caches', { configurable: true, value: undefined });
  await assert.rejects(clearImageCaches(), /unavailable/, 'unsupported browsers never report success');
  console.log('Image cache: scoped deletion, old versions, empty cache, partial failures and unavailable storage passed.');
} finally {
  if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
  else delete globalThis.caches;
}
