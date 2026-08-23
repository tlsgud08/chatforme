import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { guestDeleteSession, guestGetSessions, guestUpdateSession } from '@/lib/guest';
import type { Session } from '@/types/db';
import ConfirmDialog from '@/components/ConfirmDialog';
import { showToast } from '@/lib/toast';

type SessionRow = Session & { works: { title: string; thumbnail_url: string | null } | null };
type ViewTab = 'active' | 'multichat' | 'archived';
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
  const [inviteCode, setInviteCode] = useState('');
  const [invitePassword, setInvitePassword] = useState('');
  useEffect(() => {
    if (!menuId) return;
    const close = (event: PointerEvent) => { if (!(event.target as Element).closest('[data-popup-menu]')) setMenuId(null); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuId]);

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
    enabled: !isGuest && viewTab !== 'multichat',
  });

  const { data: multichats, isLoading: multichatsLoading } = useQuery({
    queryKey: ['multichats', user?.id],
    queryFn: async () => { const { data, error } = await supabase.from('multichat_rooms').select('*,works(title,thumbnail_url),multichat_members(count)').order('updated_at',{ascending:false}); if(error) throw error; return data as unknown as Array<{id:string;title:string;status:string;current_round:number;invite_code:string;works:{title:string;thumbnail_url:string|null}|null;multichat_members:{count:number}[]}>; },
    enabled: !isGuest && viewTab === 'multichat',
  });

  async function joinMultichat(event: React.FormEvent) {
    event.preventDefault();
    const { data: roomId, error } = await supabase.rpc('join_multichat', { room_code: inviteCode, room_password: invitePassword });
    if (error) { showToast('참가 실패: '+error.message); return; }
    window.location.assign(`/multichat/${roomId}`);
  }

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
    const { data: deleted, error } = await supabase.from('sessions').delete().in('id', ids).select('id');
    if (error || deleted?.length !== ids.length) { showToast('삭제 실패: ' + (error?.message ?? '일부 채팅방이 삭제되지 않았습니다.')); return; }
    queryClient.invalidateQueries({ queryKey: ['sessions', user?.id] });
    cancelSelect();
    showToast(`${ids.length}개 채팅방과 연결 데이터를 삭제했습니다.`);
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
      if (error) { showToast('이름 변경 실패: ' + error.message); return; }
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
      const { data: deleted, error } = await supabase.from('sessions').delete().eq('id', deleteTarget.id).select('id');
      if (error || !deleted?.length) { setDeleting(false); showToast('삭제 실패: ' + (error?.message ?? '채팅방이 삭제되지 않았습니다.')); return; }
      await queryClient.invalidateQueries({ queryKey: ['sessions', user?.id] });
    }
    setDeleting(false);
    setDeleteTarget(null);
    showToast('채팅방을 삭제했습니다.');
  }

  function rowMenu(target: { id: string; title: string; guest: boolean }) {
    return (
      <div data-popup-menu className="relative pr-2">
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
          <button
            onClick={() => { setViewTab('multichat'); cancelSelect(); }}
            className={`flex-1 py-2.5 text-sm ${viewTab === 'multichat' ? 'border-b-2 border-brand text-white' : 'text-slate-400'}`}
          >
            멀티챗
          </button>
          {viewTab !== 'multichat' && <div className="flex gap-2 px-3">
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
          </div>}
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
        {viewTab === 'multichat' && <div className="p-4">
          <div className="flex gap-2"><Link to="/multichat/new" className="flex-1 rounded-lg bg-brand py-3 text-center text-sm font-semibold text-white">+ 멀티챗 만들기</Link></div>
          <form onSubmit={joinMultichat} className="mt-3 grid grid-cols-[1fr_1fr_auto] gap-2"><input value={inviteCode} onChange={e=>setInviteCode(e.target.value.toUpperCase())} placeholder="초대 코드" className="min-w-0 rounded-lg bg-surface px-3 py-2 text-sm text-white"/><input type="password" value={invitePassword} onChange={e=>setInvitePassword(e.target.value)} placeholder="비밀번호" className="min-w-0 rounded-lg bg-surface px-3 py-2 text-sm text-white"/><button className="rounded-lg bg-surface2 px-3 text-sm text-white">참가</button></form>
          {multichatsLoading&&<p className="py-6 text-slate-400">불러오는 중…</p>}
          <ul className="mt-4 divide-y divide-surface2">{multichats?.map(r=><li key={r.id}><Link to={`/multichat/${r.id}`} className="flex items-center gap-3 py-4"><div className="h-12 w-12 overflow-hidden rounded-lg bg-surface2">{r.works?.thumbnail_url&&<img src={r.works.thumbnail_url} className="h-full w-full object-cover" alt=""/>}</div><div><p className="font-semibold text-white">{r.title}</p><p className="text-xs text-slate-500">{r.status==='lobby'?'로비':r.status==='active'?`${r.current_round}턴 진행 중`:'종료'} · {r.multichat_members?.[0]?.count??0}/2명</p></div></Link></li>)}</ul>
          {!multichatsLoading&&!multichats?.length&&<p className="py-8 text-center text-sm text-slate-500">참여 중인 멀티챗이 없습니다.</p>}
        </div>}
        {viewTab !== 'multichat' && <>
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
        </>}
      </div>
      {dialogs()}
    </div>
  );
}
