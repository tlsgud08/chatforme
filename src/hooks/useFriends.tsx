import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { FRIEND_AWAY_MS, FRIEND_HEARTBEAT_MS, friendView, loadFriendSnapshot, registerFriendShutdown, type FriendOperation, type FriendSnapshot, type FriendView, type FriendWork } from '@/lib/friends';
import { subscribeToFriendChanges } from '@/lib/friendRealtime';

interface FriendsState {
  userId: string; friends: FriendView[]; relationships: FriendSnapshot['relationships']; works: Record<string, FriendWork>;
  sharing: boolean; loading: boolean; error: string; pending: boolean;
  refresh: () => Promise<void>; change: (id: string, operation: FriendOperation) => Promise<void>;
  setSharing: (enabled: boolean) => Promise<void>; playing: (id: string | null) => () => void;
  profileId: string | null; openProfile: (id: string | null) => void; managerOpen: boolean; openManager: (open: boolean) => void;
}
const FriendsContext = createContext<FriendsState | null>(null);
const PlayingActivityContext = createContext<FriendsState['playing'] | null>(null);
export function useFriends() { return useContext(FriendsContext); }
export function usePlayingActivity(sessionId: string | null | undefined) {
  // Chat pages subscribe only to this stable registration callback, so the
  // presence clock never rerenders an entire long conversation.
  const register = useContext(PlayingActivityContext);
  useEffect(() => { if (register && sessionId) return register(sessionId); }, [register, sessionId]);
}
const message = (error: unknown) => (error as { message?: string })?.message || String(error);

export function FriendsProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<FriendSnapshot | null>(null), [works, setWorks] = useState<Record<string, FriendWork>>({});
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const [now, setNow] = useState(Date.now), [offset, setOffset] = useState(0);
  const [profileId, openProfile] = useState<string | null>(null), [managerOpen, openManager] = useState(false);
  const active = useRef(true), interaction = useRef(Date.now()), context = useRef<string | null>(null);
  const write = useRef<(() => void) | null>(null), registration = useRef(0), revision = useRef(0), mutation = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const serverOffset = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++revision.current;
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const result = await loadFriendSnapshot(controller.signal);
      if (!active.current || seq !== revision.current) return;
      serverOffset.current = Date.parse(result.snapshot.server_time) - Date.now();
      setSnapshot(result.snapshot); setWorks(result.works); setOffset(serverOffset.current); setNow(Date.now()); setError('');
    } catch (problem) { if (active.current && seq === revision.current) setError(controller.signal.aborted ? '친구 상태를 다시 확인하고 있어요.' : message(problem)); }
    finally { clearTimeout(timeout); if (active.current && seq === revision.current) setLoading(false); }
  }, [userId]);
  const playing = useCallback((id: string | null) => {
    const token = ++registration.current; context.current = id;
    if (document.visibilityState !== 'hidden') interaction.current = Date.now();
    write.current?.();
    return () => { if (registration.current === token) { context.current = null; write.current?.(); } };
  }, []);
  useEffect(() => {
    active.current = true;
    let connection = crypto.randomUUID();
    let stopped = false, sending = false, queued = false;
    let controller = new AbortController();
    async function heartbeat() {
      if (stopped) return;
      if (sending) { queued = true; return; }
      sending = true;
      const signal = controller.signal;
      try {
        const { error: problem } = await supabase.rpc('touch_friend_activity', { connection_key: connection, playing_session: context.current, interaction_at: new Date(interaction.current + serverOffset.current).toISOString() }).abortSignal(signal);
        if (problem && !stopped) setError(message(problem));
      } catch (problem) { if (!stopped && !signal.aborted) setError(message(problem)); }
      finally { sending = false; if (queued && !stopped) { queued = false; void heartbeat(); } }
    }
    async function stop() {
      if (stopped) return;
      stopped = true; controller.abort();
      const timeout = new AbortController(), timer = window.setTimeout(() => timeout.abort(), 1500);
      try { await supabase.rpc('stop_friend_activity', { connection_key: connection }).abortSignal(timeout.signal); } catch { /* The connection lease also expires server-side. */ }
      finally { window.clearTimeout(timer); }
    }
    write.current = () => { void heartbeat(); };
    const unregister = registerFriendShutdown(stop);
    const interact = () => {
      if (document.visibilityState === 'hidden') return;
      const wasAway = Date.now() - interaction.current >= FRIEND_AWAY_MS;
      interaction.current = Date.now();
      if (wasAway) void heartbeat();
    };
    const revive = () => { if (stopped && active.current) { stopped = false; connection = crypto.randomUUID(); controller = new AbortController(); } };
    const focus = () => { revive(); interact(); void heartbeat(); };
    const visibility = () => { if (document.visibilityState === 'visible') focus(); };
    const pageHide = () => { void stop(); };
    const pageShow = focus;
    for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const) window.addEventListener(event, interact, { passive: true });
    window.addEventListener('focus', focus); window.addEventListener('online', focus);
    window.addEventListener('pagehide', pageHide); window.addEventListener('pageshow', pageShow);
    document.addEventListener('visibilitychange', visibility);
    const heartbeatTimer = window.setInterval(() => { void heartbeat(); }, FRIEND_HEARTBEAT_MS);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 5000);
    void heartbeat();
    return () => {
      active.current = false; revision.current++; readController.current?.abort(); write.current = null; unregister();
      for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const) window.removeEventListener(event, interact);
      window.removeEventListener('focus', focus); window.removeEventListener('online', focus);
      window.removeEventListener('pagehide', pageHide); window.removeEventListener('pageshow', pageShow);
      document.removeEventListener('visibilitychange', visibility);
      window.clearInterval(heartbeatTimer); window.clearInterval(clockTimer); void stop();
    };
  }, [userId, refresh]);
  const friendIds = (snapshot?.relationships ?? []).filter(row => row.status === 'accepted').map(row => row.user_id).sort().join(',');
  useEffect(() => subscribeToFriendChanges(supabase, userId, friendIds.split(',').filter(Boolean), refresh), [userId, friendIds, refresh]);
  const change = useCallback(async (id: string, operation: FriendOperation) => {
    if (mutation.current) return; mutation.current = true; setPending(true);
    try { const result = await supabase.rpc('change_friendship', { other_user: id, operation }); if (result.error) throw result.error; await refresh(); }
    finally { mutation.current = false; if (active.current) setPending(false); }
  }, [refresh]);
  const setSharing = useCallback(async (enabled: boolean) => {
    if (mutation.current) return; mutation.current = true; setPending(true);
    try { const result = await supabase.rpc('set_friend_activity_sharing', { enabled }); if (result.error) throw result.error; await refresh(); }
    finally { mutation.current = false; if (active.current) setPending(false); }
  }, [refresh]);
  const friends = useMemo(() => (snapshot?.relationships ?? []).filter(row => row.status === 'accepted').map(row => friendView(row, now + offset))
    .sort((a, b) => ({ online: 0, away: 1, offline: 2, hidden: 3 }[a.presence] - { online: 0, away: 1, offline: 2, hidden: 3 }[b.presence]) || a.display_name.localeCompare(b.display_name)), [snapshot, now, offset]);
  return <PlayingActivityContext.Provider value={playing}><FriendsContext.Provider value={{ userId, friends, relationships: snapshot?.relationships ?? [], works, sharing: snapshot?.sharing_enabled ?? true, loading, error, pending, refresh, change, setSharing, playing, profileId, openProfile, managerOpen, openManager }}>{children}</FriendsContext.Provider></PlayingActivityContext.Provider>;
}
