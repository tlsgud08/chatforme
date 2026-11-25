import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { normalizeImageCachePolicy } from '@/lib/imageCachePolicy';
export const imageCachePolicyKey = (id?: string) => ['image-cache-policy', id];
export function useImageCachePolicy(id?: string) {
  return useQuery({
    queryKey: imageCachePolicyKey(id),
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.from('profiles').select('image_cache_max_entries,image_cache_max_age_days').eq('id', id!).abortSignal(signal).single();
      if (error) throw error;
      return normalizeImageCachePolicy({ maxEntries: data.image_cache_max_entries, maxAgeDays: data.image_cache_max_age_days });
    },
    enabled: !!id, staleTime: 30000, refetchOnWindowFocus: true,
  });
}
