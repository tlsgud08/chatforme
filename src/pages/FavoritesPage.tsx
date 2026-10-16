import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useQueryClient } from '@tanstack/react-query';
import { showToast } from '@/lib/toast';

interface FavEntry {
  work_id: string;
  created_at: string;
  works: { id: string; title: string; thumbnail_url: string | null } | null;
}

export default function FavoritesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [favs, setFavs] = useState<FavEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    let active = true;
    setLoading(true); setError('');
    supabase
      .from('work_favorites')
      .select('work_id, created_at, works(id, title, thumbnail_url)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!active) return;
        if (error) { setError('하트 목록을 불러오지 못했습니다.'); setLoading(false); return; }
        setFavs((data ?? []) as unknown as FavEntry[]);
        setLoading(false);
      });
    return () => { active = false; };
  }, [user]);

  async function removeFav(workId: string) {
    if (!user || removing) return;
    setRemoving(workId);
    const { error } = await supabase.from('work_favorites').delete().eq('user_id', user.id).eq('work_id', workId);
    setRemoving(null);
    if (error) { showToast('하트 삭제 실패: ' + error.message); return; }
    setFavs((f) => f.filter((x) => x.work_id !== workId));
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['user-favorites', user.id] }),
      queryClient.invalidateQueries({ queryKey: ['work-fav-me', workId, user.id] }),
      queryClient.invalidateQueries({ queryKey: ['work-fav-count', workId] }),
    ]);
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3">
        <button onClick={() => navigate('/my')} className="text-sm text-slate-400">← 뒤로</button>
        <h1 className="ml-2 font-semibold text-white">❤️ 하트 목록</h1>
      </div>

      {loading ? (
        <p className="p-6 text-slate-400">불러오는 중…</p>
      ) : error ? <p role="alert" className="p-6 text-amber-400">{error}</p> : favs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 p-10 text-center">
          <p className="text-4xl">🤍</p>
          <p className="text-sm text-slate-400">하트한 작품이 없습니다.</p>
          <p className="text-xs text-slate-500">작품 상세 화면이나 목록에서 하트를 눌러 추가하세요.</p>
        </div>
      ) : (
        <ul className="divide-y divide-surface2">
          {favs.map((f) => (
            <li key={f.work_id} className="flex items-center">
              {f.works ? <Link to={`/works/${f.work_id}`} className="flex min-w-0 flex-1 gap-3 p-4 active:bg-surface">
                <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-surface2">
                  {f.works.thumbnail_url && (
                    <img src={f.works.thumbnail_url} alt="" className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-white">{f.works.title || '(제목 없음)'}</p>
                  <p className="mt-0.5 text-xs text-slate-500">플레이하기 →</p>
                </div>
              </Link> : <div className="min-w-0 flex-1 p-4"><p className="text-sm text-slate-400">접근할 수 없는 작품</p><p className="mt-1 text-xs text-slate-500">비공개 또는 삭제된 작품입니다.</p></div>}
              <button
                onClick={() => removeFav(f.work_id)}
                disabled={!!removing} aria-label="하트 목록에서 삭제"
                className="shrink-0 px-4 py-4 text-lg leading-none disabled:opacity-50"
              >
                ❤️
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
