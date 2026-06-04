import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import WorkPosterCard from '@/components/WorkPosterCard';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import {
  fetchWorksWithStats,
  sortForSection,
  metricForSection,
  isRankingSection,
  SECTION_TITLES,
  type SectionId,
  type WorkStat,
} from '@/lib/works';

type MainTab = 'ranking' | 'new' | 'genre';

const MAIN_TABS: { id: MainTab; label: string }[] = [
  { id: 'ranking', label: '랭킹' },
  { id: 'new', label: '신작순' },
  { id: 'genre', label: '장르별' },
];

const TAB_SECTIONS: Record<Exclude<MainTab, 'genre'>, SectionId[]> = {
  ranking: ['daily', 'weekly', 'monthly'],
  new: ['today-hot', 'latest'],
};

const GENRES = ['로맨스', '판타지', '무협', '로맨스판타지', '일상', '액션', '스릴러', 'BL', 'GL'];

export default function WorksPage() {
  const [tab, setTab] = useState<MainTab>('ranking');
  const [genre, setGenre] = useState('');
  const [genreSort, setGenreSort] = useState<'latest' | 'popular'>('latest');
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({ queryKey: ['works-stats'], queryFn: fetchWorksWithStats });

  const { data: favoritedIds = [] } = useQuery({
    queryKey: ['user-favorites', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data } = await supabase
        .from('work_favorites')
        .select('work_id')
        .eq('user_id', user.id);
      return (data ?? []).map((f: { work_id: string }) => f.work_id);
    },
    enabled: !!user,
  });

  async function toggleFavorite(workId: string) {
    if (!user) return;
    const isFav = favoritedIds.includes(workId);
    queryClient.setQueryData(['user-favorites', user.id], (old: string[] = []) =>
      isFav ? old.filter((id) => id !== workId) : [...old, workId],
    );
    if (isFav) {
      await supabase.from('work_favorites').delete().eq('user_id', user.id).eq('work_id', workId);
    } else {
      await supabase.from('work_favorites').insert({ user_id: user.id, work_id: workId });
    }
  }

  return (
    <div className="flex flex-col pb-4">
      <div className="sticky top-0 z-10 flex gap-2 overflow-x-auto border-b border-surface2 bg-bg px-4 py-3">
        {MAIN_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold ${
              tab === t.id ? 'bg-brand text-white' : 'bg-surface text-slate-400'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading && <p className="p-6 text-slate-400">불러오는 중…</p>}
      {error && <p className="p-6 text-amber-400">목록을 불러오지 못했습니다.</p>}

      {!isLoading && !error && data && (
        <>
          {(tab === 'ranking' || tab === 'new') &&
            (data.length === 0 ? (
              <p className="p-6 text-slate-400">아직 작품이 없습니다. 제작 탭에서 만들어보세요.</p>
            ) : (
              <div className="flex flex-col gap-6 pt-4">
                {TAB_SECTIONS[tab].map((sid) => (
                  <Section
                    key={sid}
                    id={sid}
                    data={data}
                    favoritedIds={favoritedIds}
                    onFavoriteToggle={user ? toggleFavorite : undefined}
                  />
                ))}
              </div>
            ))}

          {tab === 'genre' && (
            <GenrePanel
              genre={genre}
              setGenre={setGenre}
              sort={genreSort}
              setSort={setGenreSort}
            />
          )}
        </>
      )}
    </div>
  );
}

function Section({
  id,
  data,
  favoritedIds,
  onFavoriteToggle,
}: {
  id: SectionId;
  data: WorkStat[];
  favoritedIds: string[];
  onFavoriteToggle?: (workId: string) => void;
}) {
  const sorted = sortForSection(id, data);
  const ranked = isRankingSection(id);
  const items = sorted.slice(0, 10);

  if (items.length === 0) {
    return (
      <section>
        <div className="mb-2 flex items-center px-4">
          <h2 className="text-base font-bold text-white">{SECTION_TITLES[id]}</h2>
        </div>
        <p className="px-4 text-sm text-slate-500">표시할 작품이 없습니다.</p>
      </section>
    );
  }

  return (
    <section>
      <Link to={`/works/section/${id}`} className="mb-2 flex items-center px-4">
        <h2 className="text-base font-bold text-white">{SECTION_TITLES[id]}</h2>
        <span className="ml-auto text-slate-500">›</span>
      </Link>
      <div className="flex gap-3 overflow-x-auto px-4 pb-1">
        {items.map((w, i) => (
          <WorkPosterCard
            key={w.id}
            work={w}
            count={metricForSection(id, w)}
            rank={ranked ? i + 1 : undefined}
            className="w-28 shrink-0"
            isFavorited={favoritedIds.includes(w.id)}
            onFavoriteToggle={onFavoriteToggle ? (workId, e) => { void e; onFavoriteToggle(workId); } : undefined}
          />
        ))}
      </div>
    </section>
  );
}

function GenrePanel({
  genre,
  setGenre,
  sort,
  setSort,
}: {
  genre: string;
  setGenre: (v: string) => void;
  sort: 'latest' | 'popular';
  setSort: (v: 'latest' | 'popular') => void;
}) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex gap-2">
        <select
          value={genre}
          onChange={(e) => setGenre(e.target.value)}
          className="flex-1 rounded-lg bg-surface px-3 py-2.5 text-sm text-white outline-none"
        >
          <option value="">장르 선택</option>
          {GENRES.map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as 'latest' | 'popular')}
          className="w-28 rounded-lg bg-surface px-3 py-2.5 text-sm text-white outline-none"
        >
          <option value="latest">최신순</option>
          <option value="popular">인기순</option>
        </select>
      </div>

      <div className="mt-4 flex flex-col items-center gap-2 rounded-xl bg-surface p-8 text-center">
        <p className="text-3xl">🚧</p>
        <p className="text-sm font-semibold text-white">장르 시스템 준비 중</p>
        <p className="text-xs text-slate-400">
          장르 분류 기능은 추후 업데이트에서 추가됩니다.
          {genre && <><br />선택한 장르: <span className="text-slate-200">{genre}</span></>}
        </p>
      </div>
    </div>
  );
}
