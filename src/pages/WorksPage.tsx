import { useQuery, useQueryClient } from '@tanstack/react-query';
import WorkPosterCard from '@/components/WorkPosterCard';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { fetchWorksWithStats, sortForSection } from '@/lib/works';

export default function WorksPage() {
  const { user, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['works-stats', { includePrivate: isAdmin }],
    queryFn: () => fetchWorksWithStats(isAdmin),
  });
  const latest = data ? sortForSection('latest', data) : [];

  const { data: favoritedIds = [] } = useQuery({
    queryKey: ['user-favorites', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data: favorites } = await supabase.from('work_favorites').select('work_id').eq('user_id', user.id);
      return (favorites ?? []).map((favorite: { work_id: string }) => favorite.work_id);
    },
    enabled: !!user,
  });

  async function toggleFavorite(workId: string) {
    if (!user) return;
    const isFavorite = favoritedIds.includes(workId);
    queryClient.setQueryData(['user-favorites', user.id], (old: string[] = []) =>
      isFavorite ? old.filter((id) => id !== workId) : [...old, workId],
    );
    if (isFavorite) {
      await supabase.from('work_favorites').delete().eq('user_id', user.id).eq('work_id', workId);
    } else {
      await supabase.from('work_favorites').insert({ user_id: user.id, work_id: workId });
    }
  }

  return (
    <div className="flex flex-col pb-4">
      <div className="sticky top-0 z-10 flex items-center border-b border-surface2 bg-bg px-4 py-3">
        <h1 className="font-bold text-white">{isAdmin ? '전체 작품 관리' : '최신 작품'}</h1>
        {latest.length > 0 && <span className="ml-auto text-xs text-slate-500">최신순</span>}
      </div>
      {isLoading && <p className="p-6 text-slate-400">불러오는 중…</p>}
      {error && <p className="p-6 text-amber-400">목록을 불러오지 못했습니다.</p>}
      {!isLoading && !error && latest.length === 0 && (
        <p className="p-6 text-slate-400">아직 작품이 없습니다. 제작 탭에서 만들어보세요.</p>
      )}
      {latest.length > 0 && (
        <div className="grid grid-cols-3 gap-x-3 gap-y-5 p-4">
          {latest.map((work) => (
            <WorkPosterCard
              key={work.id}
              work={work}
              count={work.total_play_count}
              isFavorited={favoritedIds.includes(work.id)}
              onFavoriteToggle={user ? (workId, event) => { void event; void toggleFavorite(workId); } : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
