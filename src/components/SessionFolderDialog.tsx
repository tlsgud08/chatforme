import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';

export default function SessionFolderDialog({ parentId, userId, onClose, onSaved }: {
  parentId: string | null; userId: string;
  onClose: () => void; onSaved: () => Promise<unknown>;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.from('session_folders').upsert({ id, user_id: userId, parent_id: parentId, name: name.trim() });
      if (error) throw error;
      await onSaved(); onClose();
    } catch (error) { showToast('폴더 생성 실패: ' + (error as { message: string }).message); }
    finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="folder-dialog-title">
    <form onSubmit={event => { event.preventDefault(); void save(); }} className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl">
      <h2 id="folder-dialog-title" className="font-bold text-white">{parentId ? '하위 폴더 만들기' : '폴더 만들기'}</h2>
      <input autoFocus aria-label="폴더 이름" placeholder="폴더 이름" maxLength={60} value={name} disabled={busy} onChange={event => setName(event.target.value)} className="mt-4 w-full rounded-lg bg-surface2 px-3 py-3 text-base text-white outline-none focus:ring-1 focus:ring-brand" />
      <div className="mt-4 flex gap-2"><button type="button" disabled={busy} onClick={onClose} className="flex-1 rounded-lg bg-surface2 py-3 text-sm text-slate-300">취소</button><button type="submit" disabled={busy || !name.trim()} className="flex-1 rounded-lg bg-brand py-3 text-sm text-white disabled:opacity-40">{busy ? '생성 중…' : '만들기'}</button></div>
    </form>
  </div>;
}
