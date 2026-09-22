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

self.skipWaiting();
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

const externalImageStrategy = new CacheFirst({
  cacheName: IMAGE_CACHE_NAME,
  plugins: [
    new CacheableResponsePlugin({ statuses: [0, 200] }),
    new ExpirationPlugin({
      maxEntries: 200,
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

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names
        .filter((name) => name.startsWith('chat-markdown-images-') && name !== IMAGE_CACHE_NAME)
        .map((name) => caches.delete(name)),
    )),
  );
});
