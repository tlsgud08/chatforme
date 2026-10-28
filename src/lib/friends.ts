import { supabase } from './supabase';
import { endFriendVisit } from './friendVisit';

export const FRIEND_AWAY_MS = 3 * 60_000;
export const FRIEND_CONNECTION_TTL_MS = 2 * 60_000;
export const FRIEND_HEARTBEAT_MS = 30_000;
export type FriendOperation = 'request' | 'accept' | 'reject' | 'cancel' | 'remove';
export type FriendActivityType = 'play' | 'create';
export interface FriendPlayTime { duration_ms: number; measured_at: string; running_until: string | null; }
export interface FriendConnection { activity_time?: FriendPlayTime | null; last_activity_time?: FriendPlayTime | null; play_time?: FriendPlayTime | null; last_play_time?: FriendPlayTime | null; seen_at: string; active_at: string; work_id: string | null; activity_type?: FriendActivityType | null; last_work_id?: string | null; last_activity_type?: FriendActivityType | null; }
export interface FriendRelationship {
  user_id: string; display_name: string; avatar_url: string | null;
  status: 'pending' | 'accepted'; requested_by: string; sharing_enabled: boolean;
  last_activity_time?: FriendPlayTime | null; last_play_time?: FriendPlayTime | null; last_seen_at?: string | null; last_work_id: string | null; last_activity_type?: FriendActivityType | null; last_played_at: string | null; connections: FriendConnection[];
}
export interface FriendSnapshot { server_time: string; sharing_enabled: boolean; relationships: FriendRelationship[]; }
export interface FriendWork { id: string; title: string; thumbnail_url: string | null; }
export interface FriendView extends FriendRelationship {
  presence: 'online' | 'away' | 'offline' | 'hidden'; currentWorkId: string | null; displayWorkId: string | null;
  currentActivityType: FriendActivityType | null; displayActivityType: FriendActivityType | null; lastSeenLabel: string | null; displayPlayMs: number | null; displayActivityMs: number | null;
}

/** Relative time is derived locally from the server timestamp, never written back. */
export function friendLastSeenLabel(timestamp: string | null | undefined, now: number): string | null {
  if (!timestamp) return null;
  const stamp = Date.parse(timestamp);
  if (!Number.isFinite(stamp) || !Number.isFinite(now)) return null;
  const minutes = Math.floor(Math.max(0, now - stamp) / 60_000);
  if (minutes < 1) return '방금 전 접속';
  if (minutes < 60) return `${minutes}분 전 접속`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}시간 전 접속` : `${Math.floor(hours / 24)}일 전 접속`;
}

/** Extrapolate only to the server's away/connection deadline, never forever. */
export function friendPlayMilliseconds(timer: FriendPlayTime | null | undefined, now: number): number | null {
  if (!timer || !Number.isFinite(timer.duration_ms) || timer.duration_ms < 0) return null;
  const measured = Date.parse(timer.measured_at), until = timer.running_until ? Date.parse(timer.running_until) : NaN;
  return timer.duration_ms + (Number.isFinite(now) && Number.isFinite(measured) && Number.isFinite(until) ? Math.max(0, Math.min(now, until) - measured) : 0);
}
export function formatFriendPlayTime(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return '1분 미만';
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}`;
}

/** Liveness and inactivity are separate: an idle player keeps their work. */
export function friendView(friend: FriendRelationship, now: number): FriendView {
  const live = (friend.connections ?? []).filter(connection => Number.isFinite(Date.parse(connection.seen_at)) && now - Date.parse(connection.seen_at) < FRIEND_CONNECTION_TTL_MS)
    .sort((a, b) => Date.parse(b.active_at) - Date.parse(a.active_at) || Date.parse(b.seen_at) - Date.parse(a.seen_at));
  if (!friend.sharing_enabled) return { ...friend, presence: 'hidden', currentWorkId: null, displayWorkId: null, currentActivityType: null, displayActivityType: null, lastSeenLabel: null, displayPlayMs: null, displayActivityMs: null };
  const latest = live[0];
  const presence = !latest ? 'offline' : now - Date.parse(latest.active_at) >= FRIEND_AWAY_MS ? 'away' : 'online';
  const currentWorkId = latest?.work_id ?? null;
  const displayWorkId = latest ? latest.work_id ?? latest.last_work_id ?? null : friend.last_work_id;
  const currentActivityType = currentWorkId ? latest?.activity_type ?? 'play' : null;
  const displayActivityType = displayWorkId ? currentActivityType ?? (latest ? latest.last_activity_type : friend.last_activity_type) ?? 'play' : null;
  const currentTimer = latest?.activity_time ?? (currentActivityType === 'play' ? latest?.play_time : null);
  const recentTimer = latest ? latest.last_activity_time ?? latest.last_play_time : friend.last_activity_time ?? friend.last_play_time;
  const timer = currentWorkId ? currentTimer : recentTimer;
  const displayActivityMs = displayActivityType ? friendPlayMilliseconds(timer, now) : null;
  const displayPlayMs = displayActivityType === 'play' ? displayActivityMs : null;
  return { ...friend, presence, displayPlayMs, displayActivityMs, currentWorkId, displayWorkId, currentActivityType, displayActivityType, lastSeenLabel: presence === 'offline' ? friendLastSeenLabel(friend.last_seen_at, now) : null };
}
export function friendPresenceLabel(friend: FriendView): string {
  if (friend.presence === 'offline' && friend.lastSeenLabel) return friend.lastSeenLabel;
  return { online: '접속 중', away: '자리 비움', offline: '오프라인', hidden: '활동 비공개' }[friend.presence];
}
export function friendActivityLabel(friend: FriendView, works: Record<string, FriendWork>): string {
  if (!friend.displayWorkId) return friendPresenceLabel(friend);
  const title = works[friend.displayWorkId]?.title || '비공개 작품';
  const action = friend.displayActivityType === 'create' ? '제작' : '플레이';
  if (friend.displayActivityMs != null) {
    const duration = `${formatFriendPlayTime(friend.displayActivityMs)} ${action}`;
    return friend.currentWorkId ? `${friend.presence === 'away' ? '자리 비움 · ' : ''}${title} · ${duration}${friend.presence === 'online' ? ' 중' : ''}` : `${friendPresenceLabel(friend)} · 마지막 ${action} · ${title} · ${duration}`;
  }
  return friend.currentWorkId ? `${title} ${action} 중` : `${friendPresenceLabel(friend)} · 마지막 ${action} · ${title}`;
}
export function friendActivityDescription(friend: FriendView, works: Record<string, FriendWork>): string {
  const activity = friendActivityLabel(friend, works);
  return friend.currentWorkId && !(friend.presence === 'away' && friend.displayActivityMs != null) ? `${friendPresenceLabel(friend)} · ${activity}` : activity;
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
