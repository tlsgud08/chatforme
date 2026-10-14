import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import type { Work } from '@/types/db';
import { WORK_LIST_COLUMNS, type WorkListItem } from '@/lib/works';
import ConfirmDialog from '@/components/ConfirmDialog';
import { showToast } from '@/lib/toast';

export default function CreatePage() {
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [menuId, setMenuId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!menuId) return;
    const close = (event: PointerEvent) => { if (!(event.target as Element).closest('[data-popup-menu]')) setMenuId(null); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuId]);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['my-works', user?.id, isAdmin],
    queryFn: async () => {
      let editableIds: string[] = [];
      if (!isAdmin) {
        const { data: permissions, error: permissionError } = await supabase
          .from('work_editors').select('work_id').eq('user_id', user!.id);
        if (permissionError) throw permissionError;
        editableIds = (permissions ?? []).map((item) => item.work_id);
      }
      let query = supabase.from('works').select(WORK_LIST_COLUMNS).order('updated_at', { ascending: false });
      if (!isAdmin) {
        query = editableIds.length
          ? query.or(`creator_id.eq.${user!.id},id.in.(${editableIds.join(',')})`)
          : query.eq('creator_id', user!.id);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data as WorkListItem[];
    },
  });

  async function createWork() {
    const { data, error } = await supabase
      .from('works')
      .insert({ creator_id: user!.id, title: '새 작품' })
      .select('id')
      .single();
    if (error) {
      showToast('생성 실패: ' + error.message);
      return;
    }
    await refetch();
    navigate(`/create/${data.id}`);
  }

  async function deleteWork() {
    if (!deleteTarget) return;
    setDeleting(true);
    let deleteQuery = supabase.from('works').delete().eq('id', deleteTarget.id);
    if (!isAdmin) deleteQuery = deleteQuery.eq('creator_id', user!.id);
    const { data: deleted, error } = await deleteQuery.select('id');
    setDeleting(false);
    if (error || !deleted?.length) {
      showToast('삭제 실패: ' + (error?.message ?? '삭제 권한을 확인해주세요.'));
      return;
    }
    setDeleteTarget(null);
    setMenuId(null);
    queryClient.setQueriesData({ queryKey: ['works-list'] }, (old: unknown) =>
      Array.isArray(old) ? old.filter((item: Work) => item.id !== deleteTarget.id) : old,
    );
    await Promise.all([
      refetch(),
      queryClient.invalidateQueries({ queryKey: ['works-list'] }),
    ]);
    showToast('작품을 삭제했습니다.');
  }

  async function duplicateWork(item: WorkListItem) {
    setMenuId(null);
    const { data: fullWork, error: loadError } = await supabase.from('works').select('*').eq('id', item.id).single();
    if (loadError || !fullWork) { showToast('복제할 작품을 불러오지 못했습니다.'); return; }
    const work = fullWork as Work;
    const { id: _id, created_at: _created, updated_at: _updated, ...copy } = work;
    // A copied work must never keep a reference to another work's private theme.
    const { data: created, error } = await supabase.from('works').insert({
      ...copy, default_theme_id:null, default_theme_variant:null,
      title: `${work.title || '제목 없음'} (복제본)`, creator_id: user!.id, is_published: false,
    }).select('id').single();
    if (error || !created) { showToast(`복제 실패: ${error?.message ?? '작품을 만들 수 없습니다.'}`); return; }
    const [{ data: configs }, { data: books }, { data: themes }, { data: commands }] = await Promise.all([
      supabase.from('start_configs').select('name,initial_message,initial_context,keep_turns,sort_order,is_default').eq('work_id', work.id),
      supabase.from('keyword_books').select('name,keywords,content,activation_turns,sort_order').eq('work_id', work.id),
      supabase.from('themes').select('*').eq('work_id',work.id),
      supabase.from('commands').select('name,description,prompt').eq('work_id',work.id),
    ]);
    if (configs?.length) await supabase.from('start_configs').insert(configs.map((item) => ({ ...item, work_id: created.id })));
    if (books?.length) await supabase.from('keyword_books').insert(books.map((item) => ({ ...item, work_id: created.id })));
    if (commands?.length) {
      const {error:commandError}=await supabase.from('commands').insert(commands.map(item=>({...item,work_id:created.id,owner_id:user!.id,is_published:false})));
      if(commandError)showToast('작품 전용 명령어 복제 실패: '+commandError.message);
    }
    // Map old IDs to the newly inserted IDs explicitly. INSERT RETURNING row
    // ordering is not guaranteed, so index-based mapping can attach the wrong theme.
    let copiedDefaultId = work.default_theme_id ?? null;
    for (const original of themes??[]) {
      const {data:copiedTheme,error:themesError}=await supabase.from('themes').insert({
        owner_id:user!.id,work_id:created.id,name:original.name,description:original.description,
        dark_colors:original.dark_colors,light_colors:original.light_colors,is_published:false,
      }).select('id').single();
      if(themesError){showToast('작품 전용 테마 복제 실패: '+themesError.message);continue;}
      if(original.id===work.default_theme_id) copiedDefaultId=copiedTheme!.id;
    }
    if (copiedDefaultId && (copiedDefaultId!==work.default_theme_id || !themes?.some(item=>item.id===work.default_theme_id))) {
      const {error:defaultError}=await supabase.from('works').update({
        default_theme_id:copiedDefaultId,default_theme_variant:work.default_theme_variant??null,
      }).eq('id',created.id);
      if(defaultError)showToast('기본 테마 복제 실패: '+defaultError.message);
    }
    await refetch();
    showToast('작품을 복제했습니다.');
    navigate(`/create/${created.id}`);
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
        <p className="text-slate-400">수정할 수 있는 작품이 없습니다.</p>
      ) : (
        <ul className="divide-y divide-surface2">
          {data.map((w) => (
            <li key={w.id} data-popup-menu className="relative flex items-center">
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
                    {w.creator_id !== user?.id && (isAdmin ? ' · 운영자 권한' : ' · 공동 편집')}
                  </p>
                </div>
              </Link>
              <Link to={`/works/${w.id}`} className="px-3 py-3 text-slate-500 active:text-white">
                ↗
              </Link>
              {(w.creator_id === user?.id || isAdmin) && <button
                type="button"
                aria-label={`${w.title || '작품'} 메뉴`}
                aria-expanded={menuId === w.id}
                onClick={() => setMenuId((id) => id === w.id ? null : w.id)}
                className="px-3 py-3 text-xl leading-none text-slate-400 active:text-white"
              >
                ⋯
              </button>}
              {menuId === w.id && (
                <div className="absolute right-3 top-12 z-20 w-32 overflow-hidden rounded-lg border border-surface2 bg-surface shadow-xl">
                  <button type="button" onClick={() => void duplicateWork(w)} className="w-full px-4 py-3 text-left text-sm text-slate-200 hover:bg-surface2">작품 복제</button>
                  {(w.creator_id === user?.id || isAdmin) && <button
                    type="button"
                    onClick={() => { setDeleteTarget(w); setMenuId(null); }}
                    className="w-full px-4 py-3 text-left text-sm text-red-400 active:bg-surface2"
                  >
                    작품 삭제
                  </button>}
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
