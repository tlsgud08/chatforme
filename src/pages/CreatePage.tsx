import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import type { Work } from '@/types/db';

export default function CreatePage() {
  const { user, isGuest } = useAuth();
  const navigate = useNavigate();

  if (isGuest) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-lg font-semibold text-white">작품 제작은 로그인이 필요합니다</p>
        <p className="text-sm text-slate-400">로그인하면 작품을 만들고 공유할 수 있습니다.</p>
        <button
          onClick={() => navigate('/login')}
          className="rounded-lg bg-brand px-6 py-3 font-semibold text-white"
        >
          로그인하기
        </button>
      </div>
    );
  }

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['my-works', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('works')
        .select('*')
        .eq('creator_id', user!.id)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data as Work[];
    },
  });

  async function createWork() {
    const { data, error } = await supabase
      .from('works')
      .insert({ creator_id: user!.id, title: '새 작품' })
      .select('id')
      .single();
    if (error) {
      alert('생성 실패: ' + error.message);
      return;
    }
    await refetch();
    navigate(`/create/${data.id}`);
  }

  return (
    <div className="p-4">
      <button
        onClick={createWork}
        className="mb-4 w-full rounded-lg bg-brand py-3 font-semibold text-white"
      >
        + 새 작품 만들기
      </button>

      {isLoading ? (
        <p className="text-slate-400">불러오는 중…</p>
      ) : !data || data.length === 0 ? (
        <p className="text-slate-400">아직 만든 작품이 없습니다.</p>
      ) : (
        <ul className="divide-y divide-surface2">
          {data.map((w) => (
            <li key={w.id} className="flex items-center">
              <Link to={`/create/${w.id}`} className="flex flex-1 gap-3 py-3 active:bg-surface">
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-surface2">
                  {w.thumbnail_url && (
                    <img src={w.thumbnail_url} alt="" className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-white">{w.title || '(제목 없음)'}</p>
                  <p className="truncate text-xs text-slate-500">
                    {w.visibility === 'public' ? '전체 공개' : w.visibility === 'unlisted' ? '링크 공개' : '비공개'}
                  </p>
                </div>
              </Link>
              <Link to={`/works/${w.id}`} className="px-3 py-3 text-slate-500 active:text-white">
                ↗
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
