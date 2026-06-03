import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import type { Profile, Work } from '@/types/db';

type SearchTab = 'works' | 'users';

export default function SearchPage() {
  const navigate = useNavigate();
  const { isGuest } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SearchTab>('works');
  const [works, setWorks] = useState<(Work & { creator_name: string })[]>([]);
  const [users, setUsers] = useState<(Profile & { work_count: number })[]>([]);
  const [loading, setLoading] = useState(false);
  const [creatorFilter, setCreatorFilter] = useState<string | null>(null);
  const [creatorName, setCreatorName] = useState<string | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim() || creatorFilter) runSearch();
      else { setWorks([]); setUsers([]); }
    }, 300);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tab, creatorFilter]);

  async function runSearch() {
    setLoading(true);
    if (tab === 'works') await searchWorks();
    else await searchUsers();
    setLoading(false);
  }

  async function searchWorks() {
    let q = supabase.from('works').select('*').eq('visibility', 'public');
    if (creatorFilter) {
      q = q.eq('creator_id', creatorFilter);
    } else if (query.trim()) {
      q = q.or(`title.ilike.%${query.trim()}%,description.ilike.%${query.trim()}%`);
    }
    const { data: worksData } = await q.order('created_at', { ascending: false }).limit(30);
    if (!worksData || worksData.length === 0) { setWorks([]); return; }

    const creatorIds = [...new Set((worksData as Work[]).map((w) => w.creator_id))];
    const { data: profiles } = await supabase.from('profiles').select('id, display_name').in('id', creatorIds);
    const nameMap: Record<string, string> = {};
    for (const p of profiles ?? []) nameMap[p.id] = p.display_name || '알 수 없음';
    setWorks((worksData as Work[]).map((w) => ({ ...w, creator_name: nameMap[w.creator_id] ?? '알 수 없음' })));
  }

  async function searchUsers() {
    if (isGuest) return;
    const { data: profilesData } = await supabase
      .from('profiles')
      .select('*')
      .ilike('display_name', `%${query.trim()}%`)
      .limit(30);
    if (!profilesData || profilesData.length === 0) { setUsers([]); return; }

    const ids = profilesData.map((p) => p.id);
    const { data: workData } = await supabase
      .from('works').select('creator_id').eq('visibility', 'public').in('creator_id', ids);
    const countMap: Record<string, number> = {};
    for (const w of workData ?? []) countMap[w.creator_id] = (countMap[w.creator_id] ?? 0) + 1;
    setUsers(profilesData.map((p) => ({ ...(p as Profile), work_count: countMap[p.id] ?? 0 })));
  }

  function handleUserClick(userId: string, name: string) {
    setCreatorFilter(userId);
    setCreatorName(name);
    setTab('works');
  }

  function clearCreatorFilter() {
    setCreatorFilter(null);
    setCreatorName(null);
  }

  return (
    <div className="mx-auto flex h-full max-w-app flex-col bg-bg">
      <header className="flex items-center gap-2 border-b border-surface2 px-3 py-2.5">
        <button onClick={() => navigate(-1)} className="text-slate-400">←</button>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); clearCreatorFilter(); }}
          placeholder="작품·유저 검색…"
          className="flex-1 rounded-full bg-surface px-4 py-2 text-sm text-white outline-none"
        />
        {query && (
          <button onClick={() => setQuery('')} className="text-sm text-slate-400">✕</button>
        )}
      </header>

      <div className="flex border-b border-surface2">
        {(['works', 'users'] as SearchTab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); clearCreatorFilter(); }}
            className={`flex-1 py-2.5 text-sm ${tab === t ? 'border-b-2 border-brand text-white' : 'text-slate-400'}`}
          >
            {t === 'works' ? '작품' : '유저'}
          </button>
        ))}
      </div>

      {creatorFilter && creatorName && (
        <div className="flex items-center gap-2 border-b border-surface2 px-4 py-2">
          <span className="text-xs text-slate-300">{creatorName}의 작품</span>
          <button onClick={clearCreatorFilter} className="ml-auto text-xs text-slate-500">✕ 필터 해제</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && <p className="p-6 text-center text-sm text-slate-400">검색 중…</p>}

        {!loading && tab === 'works' && (
          <>
            {works.length === 0 && (query.trim() || creatorFilter) && (
              <p className="p-6 text-center text-sm text-slate-500">검색 결과가 없습니다.</p>
            )}
            {works.length === 0 && !query.trim() && !creatorFilter && (
              <p className="p-6 text-center text-sm text-slate-500">작품 제목·설명으로 검색하세요.</p>
            )}
            <ul className="divide-y divide-surface2">
              {works.map((w) => (
                <li key={w.id}>
                  <Link to={`/works/${w.id}`} className="flex gap-3 p-4 active:bg-surface">
                    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-surface2">
                      {w.thumbnail_url && <img src={w.thumbnail_url} alt="" className="h-full w-full object-cover" />}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-white">{w.title || '(제목 없음)'}</p>
                      <p className="text-sm text-slate-400">by {w.creator_name}</p>
                      {w.description && <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">{w.description}</p>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}

        {!loading && tab === 'users' && (
          <>
            {isGuest && (
              <p className="p-6 text-center text-sm text-slate-500">유저 검색은 로그인 후 이용할 수 있습니다.</p>
            )}
            {!isGuest && users.length === 0 && query.trim() && (
              <p className="p-6 text-center text-sm text-slate-500">검색 결과가 없습니다.</p>
            )}
            {!isGuest && users.length === 0 && !query.trim() && (
              <p className="p-6 text-center text-sm text-slate-500">닉네임으로 검색하세요.</p>
            )}
            <ul className="divide-y divide-surface2">
              {users.map((u) => (
                <li key={u.id}>
                  <button
                    onClick={() => handleUserClick(u.id, u.display_name)}
                    className="flex w-full items-center gap-3 p-4 text-left active:bg-surface"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand/20 text-sm font-bold text-brand">
                      {u.display_name?.[0]?.toUpperCase() ?? '?'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-white">{u.display_name || '(이름 없음)'}</p>
                      <p className="text-xs text-slate-400">공개 작품 {u.work_count}개</p>
                    </div>
                    <span className="shrink-0 text-xs text-slate-500">작품 보기 →</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
