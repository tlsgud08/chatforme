import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

export type MultichatItemKind = 'submission' | 'assistant' | 'party';
export interface EditingTarget { kind: MultichatItemKind; id: string; }
interface EditingPresence { user_id: string; target: EditingTarget | null; }

/** Presence contains only the edited message ID, never the draft's contents. */
export function useMultichatEditing(roomId: string | undefined, userId: string | undefined, editing: EditingTarget | null) {
  const [others, setOthers] = useState<EditingPresence[]>([]);
  const latest = useRef(editing);
  latest.current = editing;
  const publish = useRef<(() => void) | null>(null);
  useEffect(() => {
    setOthers([]);
    if (!roomId || !userId) return;
    let active = true;
    const channel = supabase.channel(`multichat-editing:${roomId}`, { config: { presence: { key: crypto.randomUUID() } } });
    const track = () => { void channel.track({ user_id: userId, target: latest.current ? { kind: latest.current.kind, id: latest.current.id } : null }); };
    channel.on('presence', { event: 'sync' }, () => {
      if (!active) return;
      const entries = Object.values(channel.presenceState<EditingPresence>()).flat();
      setOthers(entries.filter(entry => entry.user_id !== userId && entry.target && ['submission', 'assistant', 'party'].includes(entry.target.kind) && typeof entry.target.id === 'string'));
    });
    channel.subscribe(status => {
      if (!active) return;
      publish.current = status === 'SUBSCRIBED' ? track : null;
      if (status === 'SUBSCRIBED') track(); else setOthers([]);
    });
    return () => { active = false; publish.current = null; void channel.untrack(); void supabase.removeChannel(channel); };
  }, [roomId, userId]);
  useEffect(() => { publish.current?.(); }, [editing?.kind, editing?.id]);
  return others;
}
