import { useState } from 'react';
import { folderPath, type SessionFolder } from '@/lib/sessionLibrary';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
export default function SessionFolderPicker({ folders, sessionIds, loading, failed, onRetry, onClose, onSaved }: {
  folders: SessionFolder[]; sessionIds: string[]; loading: boolean; failed: boolean;
  onRetry: () => void; onClose: () => void; onSaved: () => Promise<unknown>;
}) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!target || busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.from('session_folder_items').upsert(sessionIds.map(session_id => ({ folder_id: target, session_id })), { onConflict: 'folder_id,session_id', ignoreDuplicates: true });
      if (error) throw error;
      await onSaved(); onClose();
    } catch (error) { showToast('폴더에 추가 실패: ' + (error as { message: string }).message); }
    finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="folder-picker-title">
    <form onSubmit={event => { event.preventDefault(); void save(); }} className="flex max-h-[85dvh] w-full max-w-lg flex-col rounded-2xl bg-surface p-5">
      <h2 id="folder-picker-title" className="font-bold text-white">폴더에 추가</h2>
      <div className="mt-4 min-h-0 overflow-y-auto">
        {loading && <p className="text-sm text-slate-400">불러오는 중…</p>}
        {failed && <button type="button" onClick={onRetry} className="text-sm text-amber-400">폴더 불러오기 실패 · 다시 시도</button>}
        {!loading && !failed && folders.length === 0 && <p className="text-sm text-slate-400">보관함에서 폴더를 먼저 만들어 주세요.</p>}
        {folders.map(folder => <label key={folder.id} className="flex items-center gap-3 border-b border-surface2 py-3 text-sm text-white"><input type="radio" name="target-folder" value={folder.id} checked={target === folder.id} disabled={busy} onChange={() => setTarget(folder.id)} /><span className="min-w-0 break-words">{folderPath(folder, folders).map(item => item.name).join(' / ')}</span></label>)}
      </div>
      <div className="mt-4 flex gap-2"><button type="button" disabled={busy} onClick={onClose} className="flex-1 rounded-lg bg-surface2 py-3 text-sm text-slate-300">취소</button><button type="submit" disabled={!target || busy || loading || failed} className="flex-1 rounded-lg bg-brand py-3 text-sm text-white disabled:opacity-40">{busy ? '추가 중…' : '추가'}</button></div>
    </form>
  </div>;
}
