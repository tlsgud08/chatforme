import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import type { Profile } from '@/types/db';
import { WORK_LIST_COLUMNS, type WorkCard, type WorkListItem } from '@/lib/works';

type SearchTab = 'works' | 'users';

export default function SearchPage() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SearchTab>('works');
  const [works, setWorks] = useState<WorkCard[]>([]);
  const [users, setUsers] = useState<(Pick<Profile, 'id' | 'display_name' | 'avatar_url'> & { work_count: number })[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const term = query.trim();
    setError('');
    if (!term) {
      setWorks([]); setUsers([]); setLoading(false);
      return () => { active = false; controller.abort(); };
    }
    const timer = setTimeout(() => {
      setLoading(true);
      void (async () => {
        try {
          if (tab === 'works') {
            const results = await searchWorks(term, controller.signal);
            if (active) setWorks(results);
          } else {
            const results = await searchUsers(term, controller.signal);
            if (active) setUsers(results);
          }
        } catch {
          if (active) { setWorks([]); setUsers([]); setError('검색 결과를 불러오지 못했습니다. 다시 시도해 주세요.'); }
        } finally { if (active) setLoading(false); }
      })();
    }, 300);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [query, tab]);

  async function searchWorks(term: string, signal: AbortSignal) {
    const { data: worksData, error } = await supabase.from('works').select(WORK_LIST_COLUMNS)
      .eq('visibility', 'public').or(`title.ilike.%${term}%,description.ilike.%${term}%`)
      .order('created_at', { ascending: false }).limit(30).abortSignal(signal);
    if (error) throw error;
    if (!worksData?.length) return [];

    const creatorIds = [...new Set((worksData as WorkListItem[]).map((w) => w.creator_id))];
    const { data: profiles } = await supabase.from('profiles').select('id, display_name').in('id', creatorIds).abortSignal(signal);
    const nameMap: Record<string, string> = {};
    for (const p of profiles ?? []) nameMap[p.id] = p.display_name || '알 수 없음';
    return (worksData as WorkListItem[]).map((w) => ({ ...w, creator_name: nameMap[w.creator_id] ?? '알 수 없음' }));
  }

  async function searchUsers(term: string, signal: AbortSignal) {
    const { data: profilesData, error } = await supabase
      .from('profiles')
      .select('id,display_name,avatar_url')
      .ilike('display_name', `%${term}%`)
      .limit(30).abortSignal(signal);
    if (error) throw error;
    if (!profilesData?.length) return [];

    const ids = profilesData.map((p) => p.id);
    const { data: workData } = await supabase
      .from('works').select('creator_id').eq('visibility', 'public').in('creator_id', ids).abortSignal(signal);
    const countMap: Record<string, number> = {};
    for (const w of workData ?? []) countMap[w.creator_id] = (countMap[w.creator_id] ?? 0) + 1;
    return profilesData.map((p) => ({ ...p, work_count: countMap[p.id] ?? 0 }));
  }

  return (
    <div className="search-page mx-auto flex h-full max-w-app flex-col bg-bg">
      <header className="flex items-center gap-2 border-b border-surface2 px-3 py-2.5">
        <button onClick={() => navigate(-1)} className="text-slate-400">←</button>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
            onClick={() => setTab(t)}
            className={`flex-1 py-2.5 text-sm ${tab === t ? 'border-b-2 border-brand text-white' : 'text-slate-400'}`}
          >
            {t === 'works' ? '작품' : '유저'}
          </button>
        ))}
      </div>

      <div className="search-results flex-1 overflow-y-auto">
        {loading && <p className="p-6 text-center text-sm text-slate-400">검색 중…</p>}
        {error && <p role="alert" className="p-6 text-center text-sm text-amber-400">{error}</p>}

        {!loading && tab === 'works' && (
          <>
            {works.length === 0 && query.trim() && !error && (
              <p className="p-6 text-center text-sm text-slate-500">검색 결과가 없습니다.</p>
            )}
            {works.length === 0 && !query.trim() && (
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
            {users.length === 0 && query.trim() && !error && (
              <p className="p-6 text-center text-sm text-slate-500">검색 결과가 없습니다.</p>
            )}
            {users.length === 0 && !query.trim() && (
              <p className="p-6 text-center text-sm text-slate-500">닉네임으로 검색하세요.</p>
            )}
            <ul className="divide-y divide-surface2">
              {users.map((u) => (
                <li key={u.id}>
                  <button
                    onClick={() => navigate(`/users/${u.id}`)}
                    className="flex w-full items-center gap-3 p-4 text-left active:bg-surface"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand/20 text-sm font-bold text-brand">
                      {u.display_name?.[0]?.toUpperCase() ?? '?'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-white">{u.display_name || '(이름 없음)'}</p>
                      <p className="text-xs text-slate-400">공개 작품 {u.work_count}개</p>
                    </div>
                    <span className="shrink-0 text-xs text-slate-500">프로필 →</span>
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
