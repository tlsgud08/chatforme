import { supabase } from '@/lib/supabase';
import { combinedWorkIds, type CombinedWork, type CombinationWorkInfo, type WorkCombinationPrompt } from './workCombination';
import type { Session, Work } from '@/types/db';

export const COMBINATION_SEARCH_PAGE_SIZE = 20;
const QUERY_BATCH_SIZE = 100;
type CombinationSession = Pick<Session, 'work_id' | 'work_combination_enabled' | 'combined_work_ids'>;

async function fetchWorkRows<T>(ids: string[], columns: string, signal?: AbortSignal): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += QUERY_BATCH_SIZE) {
    let query = supabase.from('works').select(columns).in('id', ids.slice(offset, offset + QUERY_BATCH_SIZE));
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw new Error('결합할 작품을 불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.');
    rows.push(...(data ?? []) as unknown as T[]);
  }
  return rows;
}

/** Metadata only: never put another work's prompt into search results or session JSON. */
export async function fetchCombinationWorkInfo(ids: string[], signal?: AbortSignal): Promise<CombinationWorkInfo[]> {
  return fetchWorkRows<CombinationWorkInfo>(ids, 'id,title,description', signal);
}

export async function searchCombinationWorks(search: string, mainWorkId: string, userId: string, page: number, signal?: AbortSignal): Promise<CombinationWorkInfo[]> {
  const text = search.trim();
  if (!text) return [];
  // Filter text is passed as a value, never interpolated into the PostgREST expression.
  const escaped = text.replace(/[\\%_]/g, '\\$&');
  let query = supabase.from('works').select('id,title,description').neq('id', mainWorkId)
    .or(`visibility.neq.unlisted,creator_id.eq.${userId}`)
    .ilike('title', `%${escaped}%`).order('title').order('id')
    .range(page * COMBINATION_SEARCH_PAGE_SIZE, (page + 1) * COMBINATION_SEARCH_PAGE_SIZE - 1);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw new Error('작품 검색에 실패했습니다. 다시 시도해 주세요.');
  return (data ?? []) as CombinationWorkInfo[];
}

export async function saveWorkCombination(session: Session, userId: string, enabled: boolean, value: string[]): Promise<Pick<Session, 'work_combination_enabled' | 'combined_work_ids'>> {
  const ids = combinedWorkIds(value, session.work_id);
  const previous = combinedWorkIds(session.combined_work_ids, session.work_id);
  const { data, error } = await supabase.from('sessions')
    .update({ work_combination_enabled: enabled, combined_work_ids: ids })
    .eq('id', session.id).eq('user_id', userId).eq('work_id', session.work_id)
    .eq('work_combination_enabled', session.work_combination_enabled ?? false)
    .eq('combined_work_ids', `{${previous.join(',')}}`)
    .select('work_combination_enabled,combined_work_ids').single();
  if (error?.code === 'PGRST116') throw new Error('다른 화면에서 설정이 변경됐거나 채팅방에 접근할 수 없습니다. 설정을 새로고침해 주세요.');
  if (error?.code === '42703' || error?.code === 'PGRST204') throw new Error('작품 결합 DB 업데이트가 필요합니다. 관리자에게 문의해 주세요.');
  if (error || !data) throw new Error('작품 결합 설정을 저장하지 못했습니다. 작품 접근 권한과 연결을 확인해 주세요.');
  return data as Pick<Session, 'work_combination_enabled' | 'combined_work_ids'>;
}

/** Called before writing a user turn; missing/revoked works stop the request. */
export async function loadWorkCombination(session: CombinationSession, mainWork: Pick<Work, 'id' | 'title'>, signal?: AbortSignal): Promise<WorkCombinationPrompt | undefined> {
  if (session.work_combination_enabled !== true) return undefined;
  const ids = combinedWorkIds(session.combined_work_ids, session.work_id);
  if (!ids.length) return undefined;
  if (session.work_id !== mainWork.id) throw new Error('채팅방의 메인 작품이 변경되었습니다. 새로고침해 주세요.');
  const [works, config] = await Promise.all([
    fetchWorkRows<CombinedWork>(ids, 'id,title,main_prompt', signal),
    (() => {
      let query = supabase.from('platform_config').select('work_combination_prompt').eq('id', 1);
      if (signal) query = query.abortSignal(signal);
      return query.single();
    })(),
  ]);
  if (config.error || typeof config.data?.work_combination_prompt !== 'string') {
    throw new Error('작품 결합 지침을 불러오지 못했습니다. 관리자 설정과 DB 업데이트를 확인해 주세요.');
  }
  const byId = new Map(works.map(work => [work.id, work]));
  const ordered = ids.map((id, index) => {
    const work = byId.get(id);
    if (!work) throw new Error(`추가 ${index + 1}순위 작품이 삭제되었거나 접근 권한이 없습니다. 세션 메뉴에서 제외하거나 작품 결합을 꺼 주세요.`);
    if (!work.main_prompt.trim()) throw new Error(`추가 ${index + 1}순위 작품의 메인 프롬프트가 비어 있습니다. 세션 메뉴에서 제외해 주세요.`);
    return work;
  });
  return { enabled: true, mainWorkId: mainWork.id, mainWorkTitle: mainWork.title, instruction: config.data.work_combination_prompt, works: ordered };
}
