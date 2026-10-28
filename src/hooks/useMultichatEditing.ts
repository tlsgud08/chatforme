import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

export type MultichatItemKind = 'submission' | 'assistant' | 'party';
export interface EditingTarget { kind: MultichatItemKind; id: string; }
interface EditingPresence { user_id: string; target: EditingTarget | null; }
// The SDK reuses same-topic channels until asynchronous removal finishes.
// Presence peers require one shared topic, so serialize its teardown/recreation.
let retiring: Promise<unknown> = Promise.resolve();

/** Room presence and edited IDs only; no message/draft contents are broadcast. */
export function useMultichatEditing(roomId: string | undefined, userId: string | undefined, editing: EditingTarget | null) {
  const [state, setState] = useState<{ others: EditingPresence[]; connectedUserIds: string[]; presenceReady: boolean }>({ others: [], connectedUserIds: [], presenceReady: false });
  const latest = useRef(editing); latest.current = editing;
  const publish = useRef<(() => void) | null>(null);
  useEffect(() => {
    setState({ others: [], connectedUserIds: [], presenceReady: false });
    if (!roomId || !userId) return;
    let active = true;
    let channel: ReturnType<typeof supabase.channel> | undefined;
    void retiring.then(() => {
      if (!active) return;
      const ownChannel = supabase.channel(`multichat-editing:${roomId}`, { config: { presence: { key: crypto.randomUUID() } } });
      channel = ownChannel;
      const track = () => { void ownChannel.track({ user_id: userId, target: latest.current ? { kind: latest.current.kind, id: latest.current.id } : null }); };
      ownChannel.on('presence', { event: 'sync' }, () => {
        if (!active) return;
        const entries = Object.values(ownChannel.presenceState<EditingPresence>()).flat();
        setState({
          connectedUserIds: [...new Set(entries.filter(entry => typeof entry.user_id === 'string').map(entry => entry.user_id))], presenceReady: true,
          others: entries.filter(entry => entry.user_id !== userId && entry.target && ['submission', 'assistant', 'party'].includes(entry.target.kind) && typeof entry.target.id === 'string'),
        });
      });
      ownChannel.subscribe(status => {
        if (!active) return;
        publish.current = status === 'SUBSCRIBED' ? track : null;
        if (status === 'SUBSCRIBED') track(); else setState({ others: [], connectedUserIds: [], presenceReady: false });
      });
    });
    return () => {
      active = false; publish.current = null;
      if (channel) { const old = channel; retiring = retiring.then(() => supabase.removeChannel(old)).catch(() => {}); }
    };
  }, [roomId, userId]);
  useEffect(() => { publish.current?.(); }, [editing?.kind, editing?.id]);
  return state;
}
