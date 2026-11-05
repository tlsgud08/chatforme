import { supabase } from './supabase';
import type { WorkListItem } from './works';

export type WorkSort = 'latest' | 'messages' | 'sessions';
export interface WorkRanking { sessions: number; messages: number; }
const sortStorageKey = 'inuchat.workSort';
export function workSort(value: string | null): WorkSort {
  return value === 'sessions' || value === 'messages' ? value : 'latest';
}
export function loadWorkSort(): WorkSort {
  try { return workSort(localStorage.getItem(sortStorageKey)); } catch { return 'latest'; }
}
export function saveWorkSort(value: WorkSort) {
  try { localStorage.setItem(sortStorageKey, value); } catch { /* Browsers may disable storage. */ }
}
export async function fetchWorkRankings(ids: string[], signal?: AbortSignal): Promise<Record<string, WorkRanking>> {
  const unique = [...new Set(ids)].sort();
  const result: Record<string, WorkRanking> = {};
  for (let offset = 0; offset < unique.length; offset += 500) {
    const batch = unique.slice(offset, offset + 500);
    const request = supabase.rpc('work_catalog_counts', { target_work_ids: batch }, { get: true });
    const { data, error } = await (signal ? request.abortSignal(signal) : request);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('작품 정렬 통계를 불러오지 못했습니다.');
    for (const row of data) {
      const sessions = Number(row.session_count), messages = Number(row.message_count);
      if (!batch.includes(row.work_id) || !Number.isSafeInteger(sessions) || sessions < 0 || !Number.isSafeInteger(messages) || messages < 0) throw new Error('잘못된 작품 정렬 통계입니다.');
      result[row.work_id] = { sessions, messages };
    }
    if (batch.some(id => !result[id])) throw new Error('일부 작품의 정렬 통계를 불러오지 못했습니다.');
  }
  return result;
}
export function rankWorks(works: WorkListItem[], sort: WorkSort, stats: Record<string, WorkRanking>) {
  return [...works].sort((a, b) => {
    const difference = sort === 'sessions' ? (stats[b.id]?.sessions ?? 0) - (stats[a.id]?.sessions ?? 0)
      : sort === 'messages' ? (stats[b.id]?.messages ?? 0) - (stats[a.id]?.messages ?? 0) : 0;
    return difference || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id);
  });
}
