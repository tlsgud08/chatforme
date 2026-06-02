import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { guestGetSessions } from '@/lib/guest';
import type { Session } from '@/types/db';

type SessionRow = Session & { works: { title: string; thumbnail_url: string | null } | null };
type ViewTab = 'active' | 'archived';
type SelectMode = 'none' | 'archive' | 'delete';

export default function SessionsPage() {
  const { user, isGuest } = useAuth();
  const queryClient = useQueryClient();

  const [viewTab, setViewTab] = useState<ViewTab>('active');
  const [selectMode, setSelectMode] = useState<SelectMode>('none');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: guestData } = useQuery({
    queryKey: ['guest-sessions'],
    queryFn: guestGetSessions,
    enabled: isGuest,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['sessions', user?.id, viewTab],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sessions')
        .select('*, works(title, thumbnail_url)')
        .eq('is_archived', viewTab === 'archived')
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data as SessionRow[];
    },
    enabled: !isGuest,
  });

  function enterSelectMode(mode: 'archive' | 'delete') {
    setSelectMode(mode);
    setSelected(new Set());
  }

  function cancelSelect() {
    setSelectMode('none');
    setSelected(new Set());
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    const ids = (data ?? []).map((s) => s.id);
    if (selected.size === ids.length) setSelected(new Set());
    else setSelected(new Set(ids));
  }

  async function confirmArchive() {
    if (selected.size === 0) return;
    const ids = [...selected];
    const newVal = viewTab === 'active';
    await supabase.from('sessions').update({ is_archived: newVal }).in('id', ids);
    queryClient.invalidateQueries({ queryKey: ['sessions', user?.id] });
    cancelSelect();
  }

  async function confirmDelete() {
    if (selected.size === 0) return;
    const ids = [...selected];
    await supabase.from('sessions').delete().in('id', ids);
    queryClient.invalidateQueries({ queryKey: ['sessions', user?.id] });
    cancelSelect();
  }

  // 비회원 뷰 (보관 기능 없음)
  if (isGuest) {
    const list = guestData ?? [];
    if (list.length === 0)
      return <p className="p-6 text-slate-400">아직 플레이한 채팅방이 없습니다.</p>;
    return (
      <ul className="divide-y divide-surface2">
        {list.map((s) => (
          <li key={s.id}>
            <Link to={`/chat/${s.id}`} className="flex items-center gap-3 p-4 active:bg-surface">
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-surface2" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-white">{s.title || '채팅방'}</p>
                <p className="text-xs text-slate-500">
                  토큰 누적: {(s.total_input_tokens + s.total_output_tokens).toLocaleString()}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  const list = data ?? [];
  const allSelected = list.length > 0 && selected.size === list.length;

  return (
    <div className="flex flex-col h-full">
      {/* 상단 탭 + 버튼 영역 */}
      {selectMode === 'none' ? (
        <div className="flex items-center border-b border-surface2">
          {/* 활성 / 보관함 탭 */}
          <button
            onClick={() => setViewTab('active')}
            className={`flex-1 py-2.5 text-sm ${viewTab === 'active' ? 'border-b-2 border-brand text-white' : 'text-slate-400'}`}
          >
            활성
          </button>
          <button
            onClick={() => setViewTab('archived')}
            className={`flex-1 py-2.5 text-sm ${viewTab === 'archived' ? 'border-b-2 border-brand text-white' : 'text-slate-400'}`}
          >
            보관함
          </button>
          {/* 보관 / 삭제 버튼 */}
          <div className="flex gap-2 px-3">
            <button
              onClick={() => enterSelectMode('archive')}
              className="rounded-lg bg-surface px-3 py-1.5 text-xs text-slate-300"
            >
              {viewTab === 'active' ? '보관' : '복원'}
            </button>
            <button
              onClick={() => enterSelectMode('delete')}
              className="rounded-lg bg-surface px-3 py-1.5 text-xs text-red-400"
            >
              삭제
            </button>
          </div>
        </div>
      ) : (
        /* 선택 모드 상단 바 */
        <div className="flex items-center gap-3 border-b border-surface2 px-4 py-2.5">
          <button onClick={toggleAll} className="text-sm text-slate-300">
            {allSelected ? '전체 해제' : '전체 선택'}
          </button>
          <span className="flex-1 text-center text-sm text-slate-400">{selected.size}개 선택됨</span>
          {selectMode === 'archive' && (
            <button
              onClick={confirmArchive}
              disabled={selected.size === 0}
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            >
              {viewTab === 'active' ? '보관하기' : '복원하기'}
            </button>
          )}
          {selectMode === 'delete' && (
            <button
              onClick={confirmDelete}
              disabled={selected.size === 0}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            >
              삭제하기
            </button>
          )}
          <button onClick={cancelSelect} className="text-sm text-slate-500">
            취소
          </button>
        </div>
      )}

      {/* 목록 */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="p-6 text-slate-400">불러오는 중…</p>}
        {!isLoading && list.length === 0 && (
          <p className="p-6 text-slate-400">
            {viewTab === 'archived' ? '보관된 채팅방이 없습니다.' : '아직 플레이한 채팅방이 없습니다.'}
          </p>
        )}
        <ul className="divide-y divide-surface2">
          {list.map((s) => (
            <li key={s.id} className="flex items-center">
              {selectMode !== 'none' && (
                <button
                  onClick={() => toggleSelect(s.id)}
                  className="flex h-full items-center pl-4 pr-2"
                >
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full border-2 text-xs ${
                    selected.has(s.id)
                      ? 'border-brand bg-brand text-white'
                      : 'border-slate-600 bg-transparent'
                  }`}>
                    {selected.has(s.id) && '✓'}
                  </span>
                </button>
              )}
              <Link
                to={selectMode !== 'none' ? '#' : `/chat/${s.id}`}
                onClick={selectMode !== 'none' ? (e) => { e.preventDefault(); toggleSelect(s.id); } : undefined}
                className="flex flex-1 items-center gap-3 p-4 active:bg-surface"
              >
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-surface2">
                  {s.works?.thumbnail_url && (
                    <img src={s.works.thumbnail_url} alt="" className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-white">
                    {s.works?.title || s.title || '채팅방'}
                  </p>
                  <p className="text-xs text-slate-500">
                    토큰 누적: {(s.total_input_tokens + s.total_output_tokens).toLocaleString()}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
