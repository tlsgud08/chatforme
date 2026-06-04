import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import type { Work } from '@/types/db';

export default function CreatePage() {
  const { user, isGuest } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [cloning, setCloningId] = useState<string | null>(null);

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
    if (error) { alert('생성 실패: ' + error.message); return; }
    await refetch();
    navigate(`/create/${data.id}`);
  }

  async function cloneWork(w: Work) {
    setCloningId(w.id);
    setMenuOpenId(null);
    const { data: newWork, error } = await supabase
      .from('works')
      .insert({
        creator_id: user!.id,
        title: w.title + ' (복사)',
        description: w.description,
        thumbnail_url: w.thumbnail_url,
        main_prompt: w.main_prompt,
        is_published: false,
        visibility: 'private',
      })
      .select('id')
      .single();
    if (error) { alert('복제 실패: ' + error.message); setCloningId(null); return; }

    const [{ data: configs }, { data: kbs }] = await Promise.all([
      supabase.from('start_configs').select('*').eq('work_id', w.id).order('sort_order'),
      supabase.from('keyword_books').select('*').eq('work_id', w.id).order('sort_order'),
    ]);

    if (configs && configs.length > 0) {
      await supabase.from('start_configs').insert(
        configs.map(({ id: _id, work_id: _wid, created_at: _ca, ...rest }) => ({ ...rest, work_id: newWork.id }))
      );
    }
    if (kbs && kbs.length > 0) {
      await supabase.from('keyword_books').insert(
        kbs.map(({ id: _id, work_id: _wid, created_at: _ca, ...rest }) => ({ ...rest, work_id: newWork.id }))
      );
    }

    await refetch();
    queryClient.invalidateQueries({ queryKey: ['my-works'] });
    setCloningId(null);
    navigate(`/create/${newWork.id}`);
  }

  return (
    <div className="p-4" onClick={() => setMenuOpenId(null)}>
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
            <li key={w.id} className="flex items-center gap-3 py-3">
              {/* 썸네일 2:3 */}
              <button
                onClick={() => navigate(`/works/${w.id}`)}
                className="h-[60px] w-10 shrink-0 overflow-hidden rounded-lg bg-surface2"
              >
                {w.thumbnail_url && (
                  <img src={w.thumbnail_url} alt="" className="h-full w-full object-cover" />
                )}
              </button>

              {/* 작품 정보 — 클릭 시 작품 페이지 */}
              <button
                onClick={() => navigate(`/works/${w.id}`)}
                className="flex min-w-0 flex-1 flex-col items-start text-left"
              >
                <p className="truncate w-full font-semibold text-white">{w.title || '(제목 없음)'}</p>
                <p className="truncate w-full text-xs text-slate-500">
                  {w.visibility === 'public' ? '전체 공개' : w.visibility === 'unlisted' ? '링크 공개' : '비공개'}
                </p>
              </button>

              {/* 점 세 개 메뉴 */}
              <div className="relative shrink-0">
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === w.id ? null : w.id); }}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-slate-400 active:bg-surface2"
                >
                  ···
                </button>
                {menuOpenId === w.id && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-10 z-20 min-w-[140px] overflow-hidden rounded-xl bg-surface2 shadow-xl"
                  >
                    <button
                      onClick={() => { setMenuOpenId(null); navigate(`/create/${w.id}`); }}
                      className="w-full px-4 py-3 text-left text-sm text-white active:bg-surface"
                    >
                      수정하기
                    </button>
                    <button
                      onClick={() => cloneWork(w)}
                      disabled={cloning === w.id}
                      className="w-full px-4 py-3 text-left text-sm text-slate-300 active:bg-surface disabled:opacity-50"
                    >
                      {cloning === w.id ? '복제 중…' : '비공개로 복제'}
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
