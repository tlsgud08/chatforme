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
