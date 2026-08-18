import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import type { Work } from '@/types/db';
import ConfirmDialog from '@/components/ConfirmDialog';

export default function CreatePage() {
  const { user, isGuest } = useAuth();
  const navigate = useNavigate();
  const [menuId, setMenuId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Work | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  async function deleteWork() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await supabase.from('works').delete().eq('id', deleteTarget.id);
    setDeleting(false);
    if (error) {
      alert('삭제 실패: ' + error.message);
      return;
    }
    setDeleteTarget(null);
    setMenuId(null);
    await refetch();
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
            <li key={w.id} className="relative flex items-center">
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
              <button
                type="button"
                aria-label={`${w.title || '작품'} 메뉴`}
                aria-expanded={menuId === w.id}
                onClick={() => setMenuId((id) => id === w.id ? null : w.id)}
                className="px-3 py-3 text-xl leading-none text-slate-400 active:text-white"
              >
                ⋯
              </button>
              {menuId === w.id && (
                <div className="absolute right-3 top-12 z-20 w-32 overflow-hidden rounded-lg border border-surface2 bg-surface shadow-xl">
                  <button
                    type="button"
                    onClick={() => { setDeleteTarget(w); setMenuId(null); }}
                    className="w-full px-4 py-3 text-left text-sm text-red-400 active:bg-surface2"
                  >
                    작품 삭제
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {deleteTarget && (
        <ConfirmDialog
          title="작품을 삭제할까요?"
          description={`‘${deleteTarget.title || '제목 없음'}’ 작품과 연결된 채팅 및 설정이 모두 삭제됩니다.\n이 작업은 되돌릴 수 없습니다.`}
          busy={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void deleteWork()}
        />
      )}
    </div>
  );
}
