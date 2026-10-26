import { useSearchParams } from 'react-router-dom';
import CommandMenu from '@/components/CommandMenu';
import PluginMenu from '@/components/PluginMenu';
import ThemeMenu from '@/components/ThemeMenu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import WorkPosterCard from '@/components/WorkPosterCard';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { fetchWorkList, fetchWorkCreators } from '@/lib/works';
import { measureOperation } from '@/lib/operationTiming';
import { showToast } from '@/lib/toast';
import { useRef } from 'react';

export default function WorksPage() {
  const { user, isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const category = params.get('category');
  const selected = category === 'commands' || category === 'plugins' || category === 'themes' ? category : 'works';
  const labels = { works: '작품', commands: '명령어', plugins: '플러그인', themes: '테마' };
  const queryClient = useQueryClient();
  const favoriteLocks = useRef(new Set<string>());
  const { data, isLoading, error } = useQuery({
    queryKey: ['works-list', { includePrivate: isAdmin }, user?.id],
    queryFn: ({ signal }) => measureOperation('works', () => fetchWorkList(isAdmin, signal)),
    enabled: selected === 'works',
    staleTime: 30_000,
  });
  const latest = data ?? [];
  const creatorIds = [...new Set(latest.map(work => work.creator_id))].sort();
  const { data: creators = {} } = useQuery({
    queryKey: ['work-creators', creatorIds],
    queryFn: ({ signal }) => fetchWorkCreators(creatorIds, signal),
    enabled: selected === 'works' && creatorIds.length > 0,
    staleTime: 30_000,
  });

  const { data: favoritedIds = [] } = useQuery({
    queryKey: ['user-favorites', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data: favorites } = await supabase.from('work_favorites').select('work_id').eq('user_id', user.id);
      return (favorites ?? []).map((favorite: { work_id: string }) => favorite.work_id);
    },
    enabled: !!user && selected === 'works',
  });

  async function toggleFavorite(workId: string) {
    if (!user || favoriteLocks.current.has(workId)) return;
    favoriteLocks.current.add(workId);
    const isFavorite = favoritedIds.includes(workId);
    try {
      const { error } = isFavorite
        ? await supabase.from('work_favorites').delete().eq('user_id', user.id).eq('work_id', workId)
        : await supabase.from('work_favorites').insert({ user_id: user.id, work_id: workId });
      if (error) throw error;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['user-favorites', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['work-fav-me', workId] }),
        queryClient.invalidateQueries({ queryKey: ['work-fav-count', workId] }),
      ]);
    } catch (error) {
      showToast('하트 변경 실패: ' + (error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)));
    } finally { favoriteLocks.current.delete(workId); }
  }

  return (
    <div className="catalog-page flex flex-col pb-4">
      <div className="catalog-heading sticky top-0 z-10 flex items-center border-b border-surface2 bg-bg px-4 py-3">
        <h1 className="font-bold text-white">{labels[selected]}</h1>
        {selected === 'works' && latest.length > 0 && <span className="ml-auto text-xs text-slate-500">최신순</span>}
      </div>
      <nav aria-label="콘텐츠 종류" className="category-tabs flex gap-2 overflow-x-auto px-4 py-3">
        {(['works', 'commands', 'plugins', 'themes'] as const).map((value) => <button key={value} type="button"
          aria-pressed={selected === value}
          onClick={() => setParams((current) => { const next = new URLSearchParams(current); next.set('category', value); return next; })}
          className={`rounded-full border px-5 py-2 text-sm font-semibold ${selected === value ? 'border-brand bg-brand text-white' : 'border-surface2 bg-surface text-slate-400'}`}>
          {labels[value]}
        </button>)}
      </nav>
      {selected === 'commands' && (user ? <CommandMenu userId={user.id} embedded /> : <p className="p-4 text-sm text-slate-400">로그인 후 명령어를 관리할 수 있어요.</p>)}
      {selected === 'plugins' && (user ? <PluginMenu userId={user.id} embedded /> : <p className="p-4 text-sm text-slate-400">로그인 후 플러그인을 관리할 수 있어요.</p>)}
      {selected === 'themes' && (user ? <ThemeMenu userId={user.id} embedded /> : <p className="p-4 text-sm text-slate-400">로그인 후 테마를 관리할 수 있어요.</p>)}
      {selected === 'works' && <>
        {isLoading && <p className="p-6 text-slate-400">불러오는 중…</p>}
        {error && <p className="p-6 text-amber-400">목록을 불러오지 못했습니다.</p>}
        {!isLoading && !error && latest.length === 0 && (
          <p className="p-6 text-slate-400">아직 작품이 없습니다. 제작 탭에서 만들어보세요.</p>
        )}
        {latest.length > 0 && (
          <div className="works-grid grid grid-cols-3 gap-x-3 gap-y-5 p-4">
            {latest.map((work) => (
              <WorkPosterCard
                key={work.id}
                work={{ ...work, creator_name: creators[work.creator_id] ?? '알 수 없음' }}
                isFavorited={favoritedIds.includes(work.id)}
                onFavoriteToggle={user ? (workId, event) => { void event; void toggleFavorite(workId); } : undefined}
              />
            ))}
          </div>
        )}
      </>}
    </div>
  );
}
