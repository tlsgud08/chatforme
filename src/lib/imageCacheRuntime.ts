import { DEFAULT_IMAGE_CACHE_POLICY, normalizeImageCachePolicy, type ImageCachePolicy } from './imageCachePolicy';
export interface ImageExpiration {
  expireEntries(): Promise<void>;
  updateTimestamp(url: string): Promise<void>;
  isURLExpired(url: string): Promise<boolean>;
  delete(): Promise<void>;
}
// Serialize cleanup and policy changes so requests using an earlier limit cannot
// race a newly applied policy. Persist only policy, never account credentials.
export function createImageCacheRuntime(storage: CacheStorage, markerUrl: string, makeExpiration: (policy: ImageCachePolicy) => ImageExpiration) {
  const settingsCache = 'image-cache-settings-v1';
  let policy = DEFAULT_IMAGE_CACHE_POLICY;
  let expiration = makeExpiration(policy);
  let queue: Promise<unknown> = Promise.resolve();
  const ready = (async () => {
    try {
      const cache = await storage.open(settingsCache);
      const response = await cache.match(markerUrl);
      if (response) { policy = normalizeImageCachePolicy(await response.json()); expiration = makeExpiration(policy); }
    } catch { /* Default policy remains usable when settings storage is blocked. */ }
  })();
  function run<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(() => ready).then(task);
    queue = next.catch(() => { expiration = makeExpiration(policy); });
    return next;
  }
  return {
    set: (value: ImageCachePolicy) => run(async () => {
      const next = normalizeImageCachePolicy(value);
      const cache = await storage.open(settingsCache);
      await cache.put(markerUrl, new Response(JSON.stringify(next), { headers: { 'Content-Type': 'application/json' } }));
      policy = next; expiration = makeExpiration(policy);
      await expiration.expireEntries();
    }),
    use: (url: string, response: Response | undefined, remove: () => Promise<unknown>) => run(async () => {
      if (!response) return null;
      if (policy.maxAgeDays !== null && await expiration.isURLExpired(url)) { await remove(); return null; }
      await expiration.updateTimestamp(url);
      await expiration.expireEntries();
      return response;
    }),
    updated: (url: string) => run(async () => { await expiration.updateTimestamp(url); await expiration.expireEntries(); }),
    clear: (remove: () => Promise<unknown>) => run(async () => { await remove(); await expiration.delete(); }),
  };
}
