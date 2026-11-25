export const CHAT_IMAGE_CACHE_PREFIX = 'chat-markdown-images-';
export const WORK_THUMBNAIL_CACHE_PREFIX = 'work-thumbnails-';

/** Clear only this browser's image caches, including obsolete versions. */
export async function clearImageCaches(): Promise<void> {
  const storage = globalThis.caches;
  if (!storage) throw new Error('Cache Storage is unavailable');

  const names = (await storage.keys()).filter((name) =>
    name.startsWith(CHAT_IMAGE_CACHE_PREFIX) || name.startsWith(WORK_THUMBNAIL_CACHE_PREFIX),
  );
  // Attempt both caches even if one deletion fails. Do not report a partial
  // cleanup as success, or touch app assets, account settings, or chat data.
  const results = await Promise.allSettled(names.map((name) => storage.delete(name)));
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error('Image cache deletion failed');
  }
}

/** Entry counts are exact; StorageManager values cover the whole site, not just images. */
export async function readImageCacheUsage() {
  let chatImages: number | null = null, thumbnails: number | null = null;
  let usage: number | null = null, quota: number | null = null;
  try {
    if (globalThis.caches) {
      const names = await caches.keys();
      const count = async (prefix: string) => (await Promise.all(names.filter(name => name.startsWith(prefix)).map(async name => (await (await caches.open(name)).keys()).length))).reduce((sum, n) => sum + n, 0);
      [chatImages, thumbnails] = await Promise.all([count(CHAT_IMAGE_CACHE_PREFIX), count(WORK_THUMBNAIL_CACHE_PREFIX)]);
    }
  } catch { /* Storage access can be denied independently of the estimate API. */ }
  try {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    usage = typeof estimate?.usage === 'number' ? estimate.usage : null;
    quota = typeof estimate?.quota === 'number' ? estimate.quota : null;
  } catch { /* Keep counts visible when quota estimates are unavailable. */ }
  return { chatImages, thumbnails, usage, quota };
}
