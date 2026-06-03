import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import type { Work } from '@/types/db';

async function fetchWorks(): Promise<(Work & { creator_name: string })[]> {
  const { data: works, error } = await supabase
    .from('works')
    .select('*')
    .eq('visibility', 'public')
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (!works || works.length === 0) return [];

  const creatorIds = [...new Set((works as Work[]).map((w) => w.creator_id))];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, display_name')
    .in('id', creatorIds);

  const nameMap: Record<string, string> = {};
  for (const p of profiles ?? []) {
    nameMap[p.id] = p.display_name || '알 수 없음';
  }

  return (works as Work[]).map((w) => ({ ...w, creator_name: nameMap[w.creator_id] ?? '알 수 없음' }));
}

export default function WorksPage() {
  const { user, isGuest } = useAuth();
  const [favSet, setFavSet] = useState<Set<string>>(new Set());
  const { data, isLoading, error } = useQuery({ queryKey: ['works'], queryFn: fetchWorks });

  useEffect(() => {
    if (!user || isGuest) return;
    supabase
      .from('work_favorites')
      .select('work_id')
      .eq('user_id', user.id)
      .then(({ data }) => {
        setFavSet(new Set((data ?? []).map((f: { work_id: string }) => f.work_id)));
      });
  }, [user, isGuest]);

  async function toggleFav(e: React.MouseEvent, workId: string) {
    e.preventDefault();
    if (!user || isGuest) return;
    if (favSet.has(workId)) {
      setFavSet((s) => { const n = new Set(s); n.delete(workId); return n; });
      await supabase.from('work_favorites').delete().eq('user_id', user.id).eq('work_id', workId);
    } else {
      setFavSet((s) => new Set(s).add(workId));
      await supabase.from('work_favorites').insert({ user_id: user.id, work_id: workId });
    }
  }

  if (isLoading) return <p className="p-6 text-slate-400">불러오는 중…</p>;
  if (error) return <p className="p-6 text-amber-400">목록을 불러오지 못했습니다.</p>;
  if (!data || data.length === 0)
    return <p className="p-6 text-slate-400">아직 작품이 없습니다. 제작 탭에서 만들어보세요.</p>;

  return (
    <ul className="divide-y divide-surface2">
      {data.map((w) => (
        <li key={w.id} className="flex items-center">
          <Link to={`/works/${w.id}`} className="flex min-w-0 flex-1 gap-3 p-4 active:bg-surface">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-surface2">
              {w.thumbnail_url && (
                <img src={w.thumbnail_url} alt="" className="h-full w-full object-cover" />
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate font-semibold text-white">{w.title || '(제목 없음)'}</p>
              <p className="text-sm text-slate-400">by {w.creator_name}</p>
            </div>
          </Link>
          {user && !isGuest && (
            <button
              onClick={(e) => toggleFav(e, w.id)}
              className="shrink-0 px-4 py-4 text-lg leading-none"
            >
              {favSet.has(w.id) ? '❤️' : '🤍'}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
