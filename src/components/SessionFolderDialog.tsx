import { useState } from 'react';
import { matchesSessionSearch, type LibrarySession, type SessionFolder } from '@/lib/sessionLibrary';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';

export default function SessionFolderDialog({ folder, sessions, onClose, onSaved }: {
  folder: SessionFolder | null; sessions: LibrarySession[];
  onClose: () => void; onSaved: () => Promise<unknown>;
}) {
  const [folderId] = useState(() => folder?.id ?? crypto.randomUUID());
  const [name, setName] = useState(folder?.name ?? '');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(new Set(folder?.session_folder_items.map(item => item.session_id)));
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc('save_session_folder', {
        target_folder: folderId, folder_name: name.trim(), session_ids: [...selected],
      });
      if (error) throw error;
      await onSaved();
      onClose();
    } catch (error) {
      showToast('폴더 저장 실패: ' + (error instanceof Error ? error.message : (error as { message: string }).message));
    } finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="folder-dialog-title">
    <form onSubmit={event => { event.preventDefault(); void save(); }} className="flex max-h-[85dvh] w-full max-w-lg flex-col rounded-2xl bg-surface p-5 shadow-2xl">
      <h2 id="folder-dialog-title" className="font-bold text-white">{folder ? '폴더 편집' : '폴더 만들기'}</h2>
      <input autoFocus aria-label="폴더 이름" placeholder="폴더 이름" maxLength={60} value={name} disabled={busy} onChange={event => setName(event.target.value)} className="mt-4 rounded-lg bg-surface2 px-3 py-3 text-base text-white outline-none focus:ring-1 focus:ring-brand" />
      <input type="search" aria-label="폴더에 추가할 채팅방 검색" placeholder="채팅방·페르소나 이름 검색" value={query} onChange={event => setQuery(event.target.value)} className="mt-3 rounded-lg bg-surface2 px-3 py-3 text-base text-white outline-none focus:ring-1 focus:ring-brand" />
      <p className="py-3 text-sm text-slate-400">채팅방 선택 · {selected.size}개</p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.filter(session => matchesSessionSearch(session, query)).map(session => <label key={session.id} className="flex cursor-pointer items-center gap-3 border-b border-surface2 py-3 text-sm text-white">
          <input type="checkbox" disabled={busy} checked={selected.has(session.id)} onChange={() => setSelected(previous => { const next = new Set(previous); next.has(session.id) ? next.delete(session.id) : next.add(session.id); return next; })} className="h-4 w-4 shrink-0 accent-brand" />
          <span className="min-w-0"><span className="block truncate">{session.title || session.works?.title || '채팅방'}</span><span className="block truncate text-slate-400">{session.personas?.name || '페르소나 없음'}</span></span>
        </label>)}
        {!sessions.some(session => matchesSessionSearch(session, query)) && <p className="py-5 text-sm text-slate-400">{query.trim() ? '검색 결과가 없습니다.' : '추가할 채팅방이 없습니다.'}</p>}
      </div>
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={busy} onClick={onClose} className="flex-1 rounded-lg bg-surface2 py-3 text-sm text-slate-300 disabled:opacity-40">취소</button>
        <button type="submit" disabled={busy || !name.trim()} className="flex-1 rounded-lg bg-brand py-3 text-sm font-semibold text-white disabled:opacity-40">{busy ? '저장 중…' : '저장'}</button>
      </div>
    </form>
  </div>;
}
