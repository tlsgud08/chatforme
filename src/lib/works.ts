import { supabase } from '@/lib/supabase';
import type { Work } from '@/types/db';

export interface WorkStat extends Work {
  creator_name: string;
  day_count: number;
  week_count: number;
  month_count: number;
}

export type SectionId = 'daily' | 'weekly' | 'monthly' | 'today-hot' | 'latest';

export const SECTION_TITLES: Record<SectionId, string> = {
  daily: '일간 랭킹',
  weekly: '주간 랭킹',
  monthly: '월간 랭킹',
  'today-hot': '오늘의 인기 신작',
  latest: '최신 작품',
};

const DAY = 24 * 60 * 60 * 1000;

/** 공개 작품 + 제작자 이름 + 일/주/월 플레이 수 집계 */
export async function fetchWorksWithStats(): Promise<WorkStat[]> {
  const { data: works, error } = await supabase
    .from('works')
    .select('*')
    .eq('visibility', 'public')
    .order('created_at', { ascending: false });
  if (error) throw error;

  const list = (works as Work[]) ?? [];
  if (list.length === 0) return [];

  const creatorIds = [...new Set(list.map((w) => w.creator_id))];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, display_name')
    .in('id', creatorIds);
  const nameMap: Record<string, string> = {};
  for (const p of profiles ?? []) nameMap[p.id] = p.display_name || '알 수 없음';

  const monthAgo = new Date(Date.now() - 30 * DAY).toISOString();
  const { data: plays } = await supabase
    .from('work_plays')
    .select('work_id, created_at')
    .gte('created_at', monthAgo);

  const dayThreshold = Date.now() - DAY;
  const weekThreshold = Date.now() - 7 * DAY;
  const dayC: Record<string, number> = {};
  const weekC: Record<string, number> = {};
  const monthC: Record<string, number> = {};
  for (const p of (plays as { work_id: string; created_at: string }[]) ?? []) {
    const t = new Date(p.created_at).getTime();
    monthC[p.work_id] = (monthC[p.work_id] ?? 0) + 1;
    if (t >= weekThreshold) weekC[p.work_id] = (weekC[p.work_id] ?? 0) + 1;
    if (t >= dayThreshold) dayC[p.work_id] = (dayC[p.work_id] ?? 0) + 1;
  }

  return list.map((w) => ({
    ...w,
    creator_name: nameMap[w.creator_id] ?? '알 수 없음',
    day_count: dayC[w.id] ?? 0,
    week_count: weekC[w.id] ?? 0,
    month_count: monthC[w.id] ?? 0,
  }));
}

export function isRankingSection(id: SectionId): boolean {
  return id === 'daily' || id === 'weekly' || id === 'monthly';
}

const byNewest = (a: WorkStat, b: WorkStat) =>
  +new Date(b.created_at) - +new Date(a.created_at);

/** 섹션별 정렬된 작품 목록 */
export function sortForSection(id: SectionId, data: WorkStat[]): WorkStat[] {
  switch (id) {
    case 'daily':
      return [...data].sort((a, b) => b.day_count - a.day_count || byNewest(a, b));
    case 'weekly':
      return [...data].sort((a, b) => b.week_count - a.week_count || byNewest(a, b));
    case 'monthly':
      return [...data].sort((a, b) => b.month_count - a.month_count || byNewest(a, b));
    case 'today-hot': {
      const cutoff = Date.now() - 14 * DAY;
      return data
        .filter((w) => +new Date(w.created_at) >= cutoff)
        .sort((a, b) => b.week_count - a.week_count || byNewest(a, b));
    }
    case 'latest':
      return [...data].sort(byNewest);
  }
}

/** 섹션 카드에 표시할 플레이 수 */
export function metricForSection(id: SectionId, w: WorkStat): number {
  switch (id) {
    case 'daily':
      return w.day_count;
    case 'weekly':
    case 'today-hot':
      return w.week_count;
    default:
      return w.month_count;
  }
}

/** 61400 → "61.4K" */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

/** 채팅 시작 시 플레이 1회 기록 (실패해도 무시) */
export async function recordPlay(workId: string, userId: string | null) {
  await supabase.from('work_plays').insert({ work_id: workId, user_id: userId });
}
