/// <reference lib="webworker" />

import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';

declare let self: ServiceWorkerGlobalScope;

const IMAGE_CACHE_VERSION = 'v1';
const IMAGE_CACHE_NAME = `chat-markdown-images-${IMAGE_CACHE_VERSION}`;
const EXTERNAL_IMAGE_PATH = '/__chat-external-image';

// Cache by the complete URL, including the thumbnail upload version (?t=...).
// Unchanged images stay local; a newly uploaded thumbnail gets a new cache key.
const WORK_THUMBNAIL_CACHE_NAME = 'work-thumbnails-v1';
const supabaseOrigin = (() => {
  const endpoint = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!endpoint) return null;
  try {
    return new URL(endpoint).origin;
  } catch {
    return null;
  }
})();

self.skipWaiting();
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

const externalImageStrategy = new CacheFirst({
  cacheName: IMAGE_CACHE_NAME,
  plugins: [
    new CacheableResponsePlugin({ statuses: [0, 200] }),
    new ExpirationPlugin({
      maxEntries: 400,
      maxAgeSeconds: 60 * 60 * 24 * 30,
      purgeOnQuotaError: true,
    }),
  ],
});

registerRoute(
  ({ request, url }) => request.destination === 'image'
    && url.origin === self.location.origin
    && url.pathname === EXTERNAL_IMAGE_PATH,
  async ({ event, url }) => {
    const source = url.searchParams.get('url');
    if (!source) return Response.error();

    let externalUrl: URL;
    try {
      externalUrl = new URL(source);
    } catch {
      return Response.error();
    }

    if (!['http:', 'https:'].includes(externalUrl.protocol) || externalUrl.origin === self.location.origin) {
      return Response.error();
    }

    const request = new Request(externalUrl.href, {
      mode: 'no-cors',
      credentials: 'include',
    });

    try {
      return await externalImageStrategy.handle({ event, request });
    } catch {
      // If Cache Storage, quota management, or Workbox fails, preserve the
      // ordinary network path. Opaque responses are valid here and above.
      return fetch(request);
    }
  },
  'GET',
);

// Work thumbnails are currently stored as <owner>/<work-id>.<extension>.
// Match the owner + work id rather than the full URL, so even a change from
// PNG to WebP removes the previous thumbnail's cached copies.
const THUMBNAIL_PATH_PREFIX = '/storage/v1/object/public/thumbnails/';

function workThumbnailId(imageUrl: string): string | null {
  try {
    const { pathname } = new URL(imageUrl);
    if (!pathname.startsWith(THUMBNAIL_PATH_PREFIX)) return null;
    const path = pathname.slice(THUMBNAIL_PATH_PREFIX.length);
    const match = /^([^/]+)\/([^/]+)\.[^/.]+$/.exec(path);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

function thumbnailVersion(imageUrl: string): number {
  try {
    const version = Number(new URL(imageUrl).searchParams.get('t'));
    return Number.isSafeInteger(version) && version > 0 ? version : 0;
  } catch {
    return 0;
  }
}

// Cleanup only after the replacement was successfully placed in the cache.
// If two versions download simultaneously, keep the highest ?t= timestamp,
// not whichever response happened to arrive last.
const removeReplacedThumbnails = {
  async cacheDidUpdate({ cacheName, request }: { cacheName: string; request: Request }) {
    const workId = workThumbnailId(request.url);
    if (!workId) return;
    try {
      const cache = await caches.open(cacheName);
      const sameWork = (await cache.keys()).filter((entry) => workThumbnailId(entry.url) === workId);
      if (sameWork.length < 2) return;

      const newest = sameWork.reduce((latest, entry) => {
        const currentVersion = thumbnailVersion(entry.url);
        const latestVersion = thumbnailVersion(latest.url);
        // Prefer the replacement when both URLs have identical timestamps.
        if (currentVersion > latestVersion || (currentVersion === latestVersion && entry.url === request.url)) {
          return entry;
        }
        return latest;
      });
      await Promise.all(sameWork.filter((entry) => entry.url !== newest.url).map((entry) => cache.delete(entry)));
    } catch {
      // Storage eviction or cleanup failures should never break image loading.
    }
  },
};

// Only cache public work thumbnails from this application's Supabase project.
// CacheFirst prevents additional Supabase egress for repeat views; unlike the
// markdown-image cache, entries have no time-based expiry. Browsers may still
// evict cached data under storage pressure.
const workThumbnailStrategy = new CacheFirst({
  cacheName: WORK_THUMBNAIL_CACHE_NAME,
  plugins: [
    new CacheableResponsePlugin({ statuses: [0, 200] }),
    new ExpirationPlugin({
      maxEntries: 100,
      purgeOnQuotaError: true,
    }),
    removeReplacedThumbnails,
  ],
});

registerRoute(
  ({ request, url }) => request.destination === 'image'
    && url.origin === supabaseOrigin
    && url.pathname.startsWith('/storage/v1/object/public/thumbnails/'),
  workThumbnailStrategy,
  'GET',
);

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names
        .filter((name) =>
          (name.startsWith('chat-markdown-images-') && name !== IMAGE_CACHE_NAME)
          || (name.startsWith('work-thumbnails-') && name !== WORK_THUMBNAIL_CACHE_NAME),
        )
        .map((name) => caches.delete(name)),
    )),
  );
});
