import { useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useImageCachePolicy } from '@/hooks/useImageCachePolicy';
import { DEFAULT_IMAGE_CACHE_POLICY, sendImageCachePolicy } from '@/lib/imageCachePolicy';
export default function ImageCachePolicySync() {
  const { user, loading } = useAuth();
  const { data } = useImageCachePolicy(user?.id);
  useEffect(() => {
    if (loading || user && !data) return;
    const apply = () => { void sendImageCachePolicy(data ?? DEFAULT_IMAGE_CACHE_POLICY).catch(() => {}); };
    apply();
    navigator.serviceWorker?.addEventListener('controllerchange', apply);
    return () => navigator.serviceWorker?.removeEventListener('controllerchange', apply);
  }, [user?.id, loading, data]);
  return null;
}
