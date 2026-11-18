import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SharedSceneContent, { sceneTurnLabel, type SharedScene } from '../src/lib/sceneShareView.js';

const coverPath = '/scene-share-cover.jpg';
const coverAlt = 'Inuchat 장면 공유';
const tokenPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

const headers = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; img-src 'self' https:; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

function documentHtml(scene: SharedScene | null, origin: string, token: string, errorTitle?: string) {
  const turnLabel = scene ? sceneTurnLabel(scene.start, scene.end) : '';
  const title = scene?.title ?? errorTitle ?? '장면을 찾을 수 없어요';
  const pageTitle = title + ' · Inuchat';
  const description = scene ? turnLabel : '';
  const thumbnail = scene?.thumbnail && /^https:\/\//i.test(scene.thumbnail) ? scene.thumbnail : origin + coverPath;
  const shareUrl = origin + '/s/' + token;
  const meta = (property: string, content: string) => createElement('meta', { key: property, property, content });
  const html = createElement('html', { lang: 'ko' },
    createElement('head', null,
      createElement('meta', { charSet: 'utf-8' }),
      createElement('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      createElement('title', null, pageTitle),
      createElement('link', { rel: 'icon', href: '/favicon-32.png' }),
      createElement('link', { rel: 'stylesheet', href: '/scene-share.css' }),
      scene && [
        meta('og:type', 'website'),
        meta('og:site_name', 'Inuchat'),
        meta('og:title', title),
        meta('og:description', description),
        meta('og:url', shareUrl),
        meta('og:image', thumbnail),
        meta('og:image:alt', coverAlt),
        createElement('meta', { key: 'large-card', name: 'twitter:card', content: 'summary_large_image' }),
      ],
    ),
    createElement('body', { className: 'shared-scene-page' },
      createElement('main', { className: 'shared-scene-main' },
        createElement('header', { className: 'shared-scene-heading' },
          createElement('p', { className: 'shared-scene-brand' }, 'Inuchat'),
          scene?.thumbnail && /^https:\/\//i.test(scene.thumbnail) ? createElement('img', { className: 'shared-scene-thumbnail', src: scene.thumbnail, alt: '', referrerPolicy: 'no-referrer' }) : null,
          createElement('h1', null, title),
          scene ? createElement('p', { className: 'shared-scene-range' }, turnLabel) : null,
        ),
        scene
          ? createElement(SharedSceneContent, { scene })
          : createElement('p', null, errorTitle ? '잠시 후 다시 열어 주세요.' : '링크가 만료·삭제되었거나 주소가 올바르지 않아요.'),
      ),
    ),
  );
  return '<!doctype html>' + renderToStaticMarkup(html);
}

export default {
  async fetch(request: Request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const url = new URL(request.url);
    const match = /^\/s\/([^/]+)\/?$/.exec(url.pathname);
    const token = (match?.[1] ?? url.searchParams.get('token') ?? '').toLowerCase();
    const productionDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    const origin = process.env.VERCEL_ENV === 'production' && productionDomain
      ? 'https://' + productionDomain : url.origin;

    function page(status: number, scene: SharedScene | null = null, errorTitle?: string) {
      return new Response(request.method === 'HEAD' ? null : documentHtml(scene, origin, token, errorTitle), { status, headers });
    }

    if (!tokenPattern.test(token)) return page(404);

    const endpoint = process.env.VITE_SUPABASE_URL;
    const apiKey = process.env.VITE_SUPABASE_ANON_KEY;
    if (!endpoint || !apiKey) return page(503, null, '장면을 불러오지 못했어요');

    try {
      const response = await fetch(new URL('/rest/v1/rpc/read_scene_share', endpoint), {
        method: 'POST',
        headers: {
          apikey: apiKey,
          'Content-Type': 'application/json',
          ...(apiKey.startsWith('eyJ') ? { Authorization: 'Bearer ' + apiKey } : {}),
        },
        body: JSON.stringify({ p_token: token }),
        cache: 'no-store',
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) return page(503, null, '장면을 불러오지 못했어요');

      const scene = await response.json() as SharedScene | null;
      return scene ? page(200, scene) : page(404);
    } catch {
      return page(503, null, '장면을 불러오지 못했어요');
    }
  },
};
