import { supabase } from '@/lib/supabase';
import { availableWorkThemes } from './themeDirectives';
import type { SavedTheme } from './theme';
import { activeThemeWorkIds, type WorkThemeScope } from './workCombination';

const WORK_BATCH_SIZE = 50;
const THEME_PAGE_SIZE = 500;
type WorkName = { id: string; title: string };

/** Read references through normal RLS; never copy themes into another work. */
export async function loadWorkThemeCatalog(session: WorkThemeScope, userId: string, signal?: AbortSignal, knownWorks?: WorkName[]) {
  const ids = activeThemeWorkIds(session);
  const combined = ids.length > 1;
  const themes: SavedTheme[] = [];
  const workNames: Record<string, string> = {};
  for (let offset = 0; offset < ids.length; offset += WORK_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + WORK_BATCH_SIZE);
    if (signal?.aborted) throw new Error('작품 테마 조회를 취소했습니다.');
    if (combined) {
      let works = knownWorks?.filter(work => batch.includes(work.id));
      if (!works) {
        let query = supabase.from('works').select('id,title').in('id', batch);
        if (signal) query = query.abortSignal(signal);
        const { data, error } = await query;
        if (error) throw new Error('결합 작품의 테마 정보를 불러오지 못했습니다.');
        works = (data ?? []) as WorkName[];
      }
      for (const id of batch) {
        const work = works.find(item => item.id === id);
        if (!work) throw new Error('결합 작품이 삭제되었거나 접근 권한이 없습니다. 작품 결합 설정을 확인해 주세요.');
        workNames[id] = work.title;
      }
    }
    for (let from = 0; ; from += THEME_PAGE_SIZE) {
      let query = supabase.from('themes').select('*');
      query = combined ? query.in('work_id', batch) : query.eq('work_id', session.work_id);
      if (signal) query = query.abortSignal(signal);
      const { data, error } = await query.order('id').range(from, from + THEME_PAGE_SIZE - 1);
      if (error) throw new Error('작품 테마 목록을 불러오지 못했습니다. 연결을 확인해 주세요.');
      const rows = (data ?? []) as SavedTheme[];
      themes.push(...rows);
      if (rows.length < THEME_PAGE_SIZE) break;
    }
  }
  if (signal?.aborted) throw new Error('작품 테마 조회를 취소했습니다.');
  return {
    themes: availableWorkThemes([...new Map(themes.map(theme => [theme.id, theme])).values()], ids, userId),
    scope: combined ? { workNames } : undefined,
  };
}
