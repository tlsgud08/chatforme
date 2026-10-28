import { supabase } from './supabase';
import { endFriendVisit } from './friendVisit';

export const FRIEND_AWAY_MS = 3 * 60_000;
export const FRIEND_CONNECTION_TTL_MS = 2 * 60_000;
export const FRIEND_HEARTBEAT_MS = 30_000;
export type FriendOperation = 'request' | 'accept' | 'reject' | 'cancel' | 'remove';
export type FriendActivityType = 'play' | 'create';
export interface FriendConnection { seen_at: string; active_at: string; work_id: string | null; activity_type?: FriendActivityType | null; last_work_id?: string | null; last_activity_type?: FriendActivityType | null; }
export interface FriendRelationship {
  user_id: string; display_name: string; avatar_url: string | null;
  status: 'pending' | 'accepted'; requested_by: string; sharing_enabled: boolean;
  last_work_id: string | null; last_activity_type?: FriendActivityType | null; last_played_at: string | null; connections: FriendConnection[];
}
export interface FriendSnapshot { server_time: string; sharing_enabled: boolean; relationships: FriendRelationship[]; }
export interface FriendWork { id: string; title: string; thumbnail_url: string | null; }
export interface FriendView extends FriendRelationship {
  presence: 'online' | 'away' | 'offline' | 'hidden'; currentWorkId: string | null; displayWorkId: string | null;
  currentActivityType: FriendActivityType | null; displayActivityType: FriendActivityType | null;
}

/** Liveness and inactivity are separate: an idle player keeps their work. */
export function friendView(friend: FriendRelationship, now: number): FriendView {
  const live = (friend.connections ?? []).filter(connection => Number.isFinite(Date.parse(connection.seen_at)) && now - Date.parse(connection.seen_at) < FRIEND_CONNECTION_TTL_MS)
    .sort((a, b) => Date.parse(b.active_at) - Date.parse(a.active_at) || Date.parse(b.seen_at) - Date.parse(a.seen_at));
  if (!friend.sharing_enabled) return { ...friend, presence: 'hidden', currentWorkId: null, displayWorkId: null, currentActivityType: null, displayActivityType: null };
  const latest = live[0];
  const presence = !latest ? 'offline' : now - Date.parse(latest.active_at) >= FRIEND_AWAY_MS ? 'away' : 'online';
  const currentWorkId = latest?.work_id ?? null;
  const displayWorkId = latest ? latest.work_id ?? latest.last_work_id ?? null : friend.last_work_id;
  const currentActivityType = currentWorkId ? latest?.activity_type ?? 'play' : null;
  const displayActivityType = displayWorkId ? currentActivityType ?? (latest ? latest.last_activity_type : friend.last_activity_type) ?? 'play' : null;
  return { ...friend, presence, currentWorkId, displayWorkId, currentActivityType, displayActivityType };
}
export function friendPresenceLabel(friend: FriendView): string {
  return { online: '접속 중', away: '자리 비움', offline: '오프라인', hidden: '활동 비공개' }[friend.presence];
}
export function friendActivityLabel(friend: FriendView, works: Record<string, FriendWork>): string {
  if (!friend.displayWorkId) return friendPresenceLabel(friend);
  const title = works[friend.displayWorkId]?.title || '비공개 작품';
  const action = friend.displayActivityType === 'create' ? '제작' : '플레이';
  return friend.currentWorkId ? `${title} ${action} 중` : `${friendPresenceLabel(friend)} · 마지막 ${action} · ${title}`;
}
export function friendActivityDescription(friend: FriendView, works: Record<string, FriendWork>): string {
  const activity = friendActivityLabel(friend, works);
  return friend.currentWorkId ? `${friendPresenceLabel(friend)} · ${activity}` : activity;
}
export async function loadFriendSnapshot(signal?: AbortSignal): Promise<{ snapshot: FriendSnapshot; works: Record<string, FriendWork> }> {
  let request = supabase.rpc('get_friend_social_state');
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  if (error) throw error;
  const snapshot = data as FriendSnapshot;
  const ids = [...new Set(snapshot.relationships.flatMap(friend => [friend.last_work_id, ...friend.connections.flatMap(connection => [connection.work_id, connection.last_work_id])]).filter((id): id is string => !!id))];
  const works: Record<string, FriendWork> = {};
  // Resolve titles with the viewer's ordinary work permissions, never through a
  // privileged function or the other player's private session.
  for (let offset = 0; offset < ids.length; offset += 100) {
    let query = supabase.from('works').select('id,title,thumbnail_url').in('id', ids.slice(offset, offset + 100));
    if (signal) query = query.abortSignal(signal);
    const result = await query;
    if (result.error) throw result.error;
    for (const work of (result.data ?? []) as FriendWork[]) works[work.id] = work;
  }
  return { snapshot, works };
}

let shutdown: (() => Promise<void>) | null = null;
export function registerFriendShutdown(callback: () => Promise<void>): () => void {
  shutdown = callback;
  return () => { if (shutdown === callback) shutdown = null; };
}
export async function stopCurrentFriendActivity() { try { await shutdown?.(); } finally { endFriendVisit(); } }
