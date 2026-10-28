import InterfaceIcon from '@/components/InterfaceIcon';
import ModernPageHeading from '@/components/ModernPageHeading';
import { FriendActivityStrip } from '@/components/Friends';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { fetchSessionConversationCounts, sessionCountsKey } from '@/lib/sessionCounts';
import { measureOperation } from '@/lib/operationTiming';
import { useAuth } from '@/hooks/useAuth';
import type { Session } from '@/types/db';
import ConfirmDialog from '@/components/ConfirmDialog';
import { showToast } from '@/lib/toast';
import { showConfirmDialog } from '@/lib/dialog';

type SessionRow = Pick<Session, 'id' | 'title'> & { works: { title: string; thumbnail_url: string | null } | null };
type ViewTab = 'active' | 'multichat' | 'archived';
type SelectMode = 'none' | 'archive' | 'delete';

export default function SessionsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [searchParams] = useSearchParams();
  const [viewTab, setViewTab] = useState<ViewTab>(searchParams.get('tab') === 'multichat' ? 'multichat' : 'active');
  const [selectMode, setSelectMode] = useState<SelectMode>('none');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!menuId) return;
    const close = (event: PointerEvent) => { if (!(event.target as Element).closest('[data-popup-menu]')) setMenuId(null); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuId]);

  const { data: list = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['sessions', user?.id, viewTab],
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase
        .from('sessions')
        .select('id,title,works(title,thumbnail_url)')
        .eq('user_id', user!.id).is('multichat_room_id', null)
        .eq('is_archived', viewTab === 'archived')
        .order('updated_at', { ascending: false }).abortSignal(signal);
      if (error) throw error;

      return (data as unknown as SessionRow[]) ?? [];
    },
    enabled: !!user && viewTab !== 'multichat',
    staleTime: 30_000,
  });

  const { data: turnCountMap = {}, isError: countsError, refetch: refetchCounts } = useQuery({
    queryKey: sessionCountsKey(user?.id, list.map(session => session.id)),
    queryFn: ({ signal }) => measureOperation('session-counts', () => fetchSessionConversationCounts(list.map(session => session.id), signal)),
    enabled: !!user && viewTab !== 'multichat' && list.length > 0,
    staleTime: 30_000,
  });

  const { data: multichats, isLoading: multichatsLoading, isError: multichatsError, refetch: refetchMultichats } = useQuery({
    queryKey: ['multichats', user?.id],
    queryFn: async () => { const { data, error } = await supabase.from('multichat_rooms').select('*,works(title,thumbnail_url),multichat_members(user_id,slot)').order('updated_at',{ascending:false}); if(error) throw error; return data as unknown as Array<{id:string;host_user_id:string;title:string;status:string;current_round:number;invite_code:string;works:{title:string;thumbnail_url:string|null}|null;multichat_members:{user_id:string;slot:number}[]}>; },
    enabled: viewTab === 'multichat',
    refetchInterval: viewTab === 'multichat' ? 5000 : false,
  });

  useEffect(() => {
    if (viewTab !== 'multichat' || !user) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => { clearTimeout(timer); timer = setTimeout(() => { void queryClient.invalidateQueries({ queryKey: ['multichats', user.id] }); }, 100); };
    const channel = supabase.channel(`multichat-list:${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'multichat_rooms' }, changed)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'multichat_members' }, changed).subscribe();
    return () => { clearTimeout(timer); void supabase.removeChannel(channel); };
  }, [viewTab, user?.id, queryClient]);

  async function joinMultichat(roomId: string) {
    const { data, error } = await supabase.rpc('join_multichat_room', { target_room: roomId });
    if (error) { showToast('참가 실패: ' + error.message); return; }
    window.location.assign(`/multichat/${data}`);
  }

  async function deleteMultichat(room: { id: string; title: string }) {
    const confirmed = await showConfirmDialog(
      '멀티챗 방을 삭제할까요?',
      `‘${room.title}’의 게임 기록과 파티 메시지가 모두 삭제됩니다. 이 작업은 되돌릴 수 없습니다.`,
      '삭제',
    );
    if (!confirmed) return;
    const { error } = await supabase.rpc('delete_multichat', { target_room: room.id });
    if (error) { showToast('멀티챗 삭제 실패: ' + error.message); return; }
    await queryClient.invalidateQueries({ queryKey: ['multichats', user?.id] });
    showToast('멀티챗 방을 삭제했습니다.');
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
    const ids = list.map((s) => s.id);
    if (selected.size === ids.length) setSelected(new Set());
    else setSelected(new Set(ids));
  }

  async function confirmArchive() {
    if (selected.size === 0) return;
    const ids = [...selected];
    const newVal = viewTab === 'active';
    const { error } = await supabase.from('sessions').update({ is_archived: newVal }).in('id', ids);
    if (error) { showToast('보관 상태 변경 실패: ' + error.message); return; }
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

  function openRename(target: { id: string; title: string }) {
    setMenuId(null);
    setRenameTarget(target);
    setRenameValue(target.title);
  }

  async function saveRename() {
    if (!renameTarget || !renameValue.trim()) return;
    const title = renameValue.trim().slice(0, 60);
    const { error } = await supabase.from('sessions').update({ title, updated_at: new Date().toISOString() }).eq('id', renameTarget.id);
    if (error) { showToast('이름 변경 실패: ' + error.message); return; }
    await queryClient.invalidateQueries({ queryKey: ['sessions', user?.id] });
    setRenameTarget(null);
  }

  async function deleteOne() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { data: deleted, error } = await supabase.from('sessions').delete().eq('id', deleteTarget.id).select('id');
    if (error || !deleted?.length) { setDeleting(false); showToast('삭제 실패: ' + (error?.message ?? '채팅방이 삭제되지 않았습니다.')); return; }
    await queryClient.invalidateQueries({ queryKey: ['sessions', user?.id] });
    setDeleting(false);
    setDeleteTarget(null);
    showToast('채팅방을 삭제했습니다.');
  }

  function rowMenu(target: { id: string; title: string }) {
    return (
      <div data-popup-menu className="relative pr-2">
        <button
          type="button"
          aria-label={`${target.title} 메뉴`}
          aria-expanded={menuId === target.id}
          onClick={() => setMenuId((id) => id === target.id ? null : target.id)}
          className="px-3 py-3 text-xl leading-none text-slate-400 active:text-white"
        >
          <InterfaceIcon name="more" />
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

  const allSelected = list.length > 0 && selected.size === list.length;

  return (
    <div className="sessions-page flex flex-col h-full">
      <ModernPageHeading title="채팅방" />
      <FriendActivityStrip />
      {/* 상단 탭 + 버튼 영역 */}
      {selectMode === 'none' ? (
        <div className="sessions-tabs flex items-center border-b border-surface2">
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
          <Link to="/multichat/new" className="block rounded-lg bg-brand py-3 text-center text-sm font-semibold text-white">+ 멀티챗 만들기</Link>
          <p className="mt-3 text-xs text-slate-500">모든 멀티챗 방이 여기에 표시돼요. 시작 전 방에 바로 참가할 수 있어요.</p>
          {multichatsLoading && <p className="py-6 text-slate-400">불러오는 중…</p>}
          {multichatsError && <p role="alert" className="py-5 text-sm text-slate-400">방 목록을 불러오지 못했습니다. <button onClick={() => void refetchMultichats()} className="underline">다시 시도</button></p>}
          {(['lobby', 'active'] as const).map(status => <section key={status} className="mt-6">
            <h2 className="text-sm font-semibold text-white">{status === 'lobby' ? '시작 전' : '진행 중'} <span className="ml-1 text-xs text-slate-500">{multichats?.filter(room => status === 'lobby' ? room.status === 'lobby' : room.status !== 'lobby').length ?? 0}</span></h2>
            <ul className="mt-2 divide-y divide-surface2">{multichats?.filter(room => status === 'lobby' ? room.status === 'lobby' : room.status !== 'lobby').map(room => {
              const joined = room.multichat_members.some(member => member.user_id === user?.id), full = room.multichat_members.length >= 2;
              return <li key={room.id} className="flex items-center gap-3 py-4">
                <div className="h-14 w-11 shrink-0 overflow-hidden rounded-lg bg-surface">{room.works?.thumbnail_url && <img src={room.works.thumbnail_url} alt="" className="h-full w-full object-cover" />}</div>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-white">{room.title}</p><p className="mt-1 truncate text-xs text-slate-500">{room.works?.title}</p><p className="mt-1 text-xs text-slate-500">{room.multichat_members.length}/2명 · {room.status === 'lobby' ? '참여자 모집 중' : `${Math.max(0, room.current_round - 1)}턴`}</p></div>
                {joined ? <Link to={`/multichat/${room.id}`} className="rounded-lg bg-surface px-3 py-2 text-xs text-slate-200">열기</Link> : room.status === 'lobby' && !full ? <button className="rounded-lg bg-brand px-3 py-2 text-xs text-white" onClick={() => void joinMultichat(room.id)}>참가</button> : <span className="text-xs text-slate-500">진행 중</span>}
                {room.host_user_id === user?.id && <button aria-label={`${room.title} 삭제`} className="text-xs text-red-400" onClick={() => void deleteMultichat(room)}>삭제</button>}
              </li>;
            })}</ul>
            {!multichatsLoading && !multichatsError && !multichats?.some(room => status === 'lobby' ? room.status === 'lobby' : room.status !== 'lobby') && <p className="py-5 text-xs text-slate-500">{status === 'lobby' ? '시작 전인 방이 없어요.' : '진행 중인 방이 없어요.'}</p>}
          </section>)}
        </div>}
        {viewTab !== 'multichat' && <>
        {isLoading && <p className="p-6 text-slate-400">불러오는 중…</p>}
        {isError && <p role="alert" className="p-6 text-amber-400">채팅방 목록을 불러오지 못했습니다. <button type="button" onClick={() => void refetch()} className="underline">다시 불러오기</button></p>}
        {countsError && list.length > 0 && <p className="px-4 py-2 text-xs text-slate-400">대화 수를 불러오지 못했습니다. <button type="button" onClick={() => void refetchCounts()} className="underline">다시 불러오기</button></p>}
        {!isLoading && !isError && list.length === 0 && (
          <p className="p-6 text-slate-400">
            {viewTab === 'archived' ? '보관된 채팅방이 없습니다.' : '아직 플레이한 채팅방이 없습니다.'}
          </p>
        )}
        <ul className="session-list divide-y divide-surface2">
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
                <div className="session-list-thumb h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-surface2">
                  {s.works?.thumbnail_url && (
                    <img src={s.works.thumbnail_url} alt="" className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-white">
                    {s.title || s.works?.title || '채팅방'}
                  </p>
                  <p className="text-xs text-slate-500">
                    {turnCountMap[s.id] ?? (countsError ? '—' : '…')} 대화
                  </p>
                </div>
              </Link>
              {selectMode === 'none' && rowMenu({ id: s.id, title: s.title || s.works?.title || '채팅방' })}
            </li>
          ))}
        </ul>
        </>}
      </div>
      {dialogs()}
    </div>
  );
}
