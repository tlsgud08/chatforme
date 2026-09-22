import { useEffect, useState } from 'react';

const EXTERNAL_IMAGE_PATH = '/__chat-external-image';

function isCacheableExternalImage(src: string): boolean {
  try {
    const url = new URL(src, window.location.href);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function getImageSource(src: string): string {
  if (!isCacheableExternalImage(src) || !navigator.serviceWorker?.controller) return src;

  const proxyUrl = new URL(EXTERNAL_IMAGE_PATH, window.location.origin);
  proxyUrl.searchParams.set('url', new URL(src, window.location.href).href);
  return proxyUrl.href;
}

type MarkdownImageProps = {
  src?: string;
  alt?: string;
};

/** Restricts the service-worker image cache to images rendered from chat Markdown. */
export default function MarkdownImage({ src, alt = '' }: MarkdownImageProps) {
  const originalSrc = src ?? '';
  const [displaySrc, setDisplaySrc] = useState(() => getImageSource(originalSrc));

  useEffect(() => {
    const updateSource = () => setDisplaySrc(getImageSource(originalSrc));
    updateSource();
    navigator.serviceWorker?.addEventListener('controllerchange', updateSource);
    return () => navigator.serviceWorker?.removeEventListener('controllerchange', updateSource);
  }, [originalSrc]);

  return (
    <img
      src={displaySrc}
      alt={alt}
      className="my-2 block h-auto max-w-full"
      loading="lazy"
      onError={() => {
        // A blocked cross-origin fetch or a cache failure must not replace the
        // browser's normal image-loading behavior.
        if (displaySrc !== originalSrc) setDisplaySrc(originalSrc);
      }}
    />
  );
}
