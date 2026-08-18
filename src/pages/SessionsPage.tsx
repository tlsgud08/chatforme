import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { guestDeleteSession, guestGetSessions, guestUpdateSession } from '@/lib/guest';
import type { Session } from '@/types/db';
import ConfirmDialog from '@/components/ConfirmDialog';

type SessionRow = Session & { works: { title: string; thumbnail_url: string | null } | null };
type ViewTab = 'active' | 'archived';
type SelectMode = 'none' | 'archive' | 'delete';

export default function SessionsPage() {
  const { user, isGuest } = useAuth();
  const queryClient = useQueryClient();

  const [viewTab, setViewTab] = useState<ViewTab>('active');
  const [selectMode, setSelectMode] = useState<SelectMode>('none');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string; guest: boolean } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string; guest: boolean } | null>(null);
  const [deleting, setDeleting] = useState(false);

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

      const sessions = (data as SessionRow[]) ?? [];
      if (sessions.length === 0) return { sessions, aiCountMap: {} as Record<string, number> };

      const sessionIds = sessions.map((s) => s.id);
      const { data: msgRows } = await supabase
        .from('messages')
        .select('session_id')
        .in('session_id', sessionIds)
        .eq('role', 'assistant')
        .eq('is_hidden', false)
        .gt('turn_index', 0);

      const aiCountMap: Record<string, number> = {};
      for (const m of (msgRows ?? []) as { session_id: string }[]) {
        aiCountMap[m.session_id] = (aiCountMap[m.session_id] ?? 0) + 1;
      }

      return { sessions, aiCountMap };
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
    const ids = (data?.sessions ?? []).map((s) => s.id);
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

  function openRename(target: { id: string; title: string; guest: boolean }) {
    setMenuId(null);
    setRenameTarget(target);
    setRenameValue(target.title);
  }

  async function saveRename() {
    if (!renameTarget || !renameValue.trim()) return;
    const title = renameValue.trim().slice(0, 60);
    if (renameTarget.guest) {
      guestUpdateSession(renameTarget.id, { title });
      await queryClient.invalidateQueries({ queryKey: ['guest-sessions'] });
    } else {
      const { error } = await supabase.from('sessions').update({ title, updated_at: new Date().toISOString() }).eq('id', renameTarget.id);
      if (error) { alert('이름 변경 실패: ' + error.message); return; }
      await queryClient.invalidateQueries({ queryKey: ['sessions', user?.id] });
    }
    setRenameTarget(null);
  }

  async function deleteOne() {
    if (!deleteTarget) return;
    setDeleting(true);
    if (deleteTarget.guest) {
      guestDeleteSession(deleteTarget.id);
      await queryClient.invalidateQueries({ queryKey: ['guest-sessions'] });
    } else {
      const { error } = await supabase.from('sessions').delete().eq('id', deleteTarget.id);
      if (error) { setDeleting(false); alert('삭제 실패: ' + error.message); return; }
      await queryClient.invalidateQueries({ queryKey: ['sessions', user?.id] });
    }
    setDeleting(false);
    setDeleteTarget(null);
  }

  function rowMenu(target: { id: string; title: string; guest: boolean }) {
    return (
      <div className="relative pr-2">
        <button
          type="button"
          aria-label={`${target.title} 메뉴`}
          aria-expanded={menuId === target.id}
          onClick={() => setMenuId((id) => id === target.id ? null : target.id)}
          className="px-3 py-3 text-xl leading-none text-slate-400 active:text-white"
        >
          ⋯
        </button>
        {menuId === target.id && (
          <div className="absolute right-2 top-11 z-20 w-32 overflow-hidden rounded-lg border border-surface2 bg-surface shadow-xl">
            <button type="button" onClick={() => openRename(target)} className="w-full px-4 py-3 text-left text-sm text-slate-200 active:bg-surface2">이름 바꾸기</button>
            <button type="button" onClick={() => { setMenuId(null); setDeleteTarget(target); }} className="w-full px-4 py-3 text-left text-sm text-red-400 active:bg-surface2">삭제</button>
          </div>
        )}
      </div>
    );
  }

  function dialogs() {
    return (
      <>
        {renameTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5" role="dialog" aria-modal="true" aria-labelledby="rename-title">
            <form onSubmit={(event) => { event.preventDefault(); void saveRename(); }} className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl">
              <h2 id="rename-title" className="font-bold text-white">채팅방 이름 바꾸기</h2>
              <input autoFocus maxLength={60} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} className="mt-4 w-full rounded-lg bg-surface2 px-4 py-3 text-sm text-white outline-none ring-1 ring-transparent focus:ring-brand" />
              <div className="mt-4 flex gap-2">
                <button type="button" onClick={() => setRenameTarget(null)} className="flex-1 rounded-lg bg-surface2 py-2.5 text-sm text-slate-300">취소</button>
                <button type="submit" disabled={!renameValue.trim()} className="flex-1 rounded-lg bg-brand py-2.5 text-sm font-semibold text-white disabled:opacity-40">저장</button>
              </div>
            </form>
          </div>
        )}
        {deleteTarget && (
          <ConfirmDialog
            title="채팅방을 삭제할까요?"
            description={`‘${deleteTarget.title}’의 모든 대화가 영구적으로 삭제됩니다.\n이 작업은 되돌릴 수 없습니다.`}
            busy={deleting}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={() => void deleteOne()}
          />
        )}
      </>
    );
  }

  // 비회원 뷰
  if (isGuest) {
    const list = guestData ?? [];
    if (list.length === 0)
      return <p className="p-6 text-slate-400">아직 플레이한 채팅방이 없습니다.</p>;
    return (
      <div>
        <ul className="divide-y divide-surface2">
          {list.map((s) => {
          const aiCount = s.messages.filter((m) => m.role === 'assistant' && !m.is_hidden && m.turn_index > 0).length;
          return (
            <li key={s.id} className="flex items-center">
              <Link to={`/chat/${s.id}`} className="flex flex-1 items-center gap-3 p-4 active:bg-surface">
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-surface2" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-white">{s.title || '채팅방'}</p>
                  <p className="text-xs text-slate-500">{aiCount} 대화</p>
                </div>
              </Link>
              {rowMenu({ id: s.id, title: s.title || '채팅방', guest: true })}
            </li>
          );
          })}
        </ul>
        {dialogs()}
      </div>
    );
  }

  const list = data?.sessions ?? [];
  const aiCountMap = data?.aiCountMap ?? {};
  const allSelected = list.length > 0 && selected.size === list.length;

  return (
    <div className="flex flex-col h-full">
      {/* 상단 탭 + 버튼 영역 */}
      {selectMode === 'none' ? (
        <div className="flex items-center border-b border-surface2">
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
                    {s.title || s.works?.title || '채팅방'}
                  </p>
                  <p className="text-xs text-slate-500">
                    {aiCountMap[s.id] ?? 0} 대화
                  </p>
                </div>
              </Link>
              {selectMode === 'none' && rowMenu({ id: s.id, title: s.title || s.works?.title || '채팅방', guest: false })}
            </li>
          ))}
        </ul>
      </div>
      {dialogs()}
    </div>
  );
}
