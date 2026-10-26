import { supabase } from '@/lib/supabase';
import type { Work } from '@/types/db';

/** List rows deliberately exclude prompt bodies. Detail/editor pages fetch them. */
export type WorkListItem = Pick<Work, 'id' | 'creator_id' | 'title' | 'description' | 'thumbnail_url' | 'visibility' | 'created_at' | 'updated_at'>;
export interface WorkCard extends WorkListItem { creator_name: string; }
export const WORK_LIST_COLUMNS = 'id,creator_id,title,description,thumbnail_url,visibility,created_at,updated_at';

export async function fetchWorkList(includePrivate = false, signal?: AbortSignal): Promise<WorkListItem[]> {
  let query = supabase.from('works').select(WORK_LIST_COLUMNS).order('created_at', { ascending: false });
  if (!includePrivate) query = query.eq('visibility', 'public');
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  if (error) throw error;
  return (data as WorkListItem[]) ?? [];
}

export async function fetchWorkCreators(creatorIds: string[], signal?: AbortSignal): Promise<Record<string, string>> {
  if (!creatorIds.length) return {};
  const query = supabase.from('public_profiles').select('id,display_name').in('id', [...new Set(creatorIds)]);
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map(profile => [profile.id, profile.display_name || '알 수 없음']));
}

/** Compatibility helper; interactive lists load optional creators separately. */
export async function fetchWorks(includePrivate = false): Promise<WorkCard[]> {
  const list = await fetchWorkList(includePrivate);
  const names = await fetchWorkCreators(list.map(work => work.creator_id)).catch(() => ({} as Record<string, string>));
  return list.map(work => ({ ...work, creator_name: names[work.creator_id] ?? '알 수 없음' }));
}

/** Compact display for favorites, unrelated to removed play statistics. */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}
