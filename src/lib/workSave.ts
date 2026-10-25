import { supabase } from './supabase';
import type { KeywordBook, StartConfig, Work } from '@/types/db';

export interface WorkEditorState { work: Work; starts: StartConfig[]; keywords: KeywordBook[]; }
const pick = (row: object, keys: string[]) => Object.fromEntries(keys.map(key => [key, (row as Record<string, unknown>)[key] ?? null]));
export function workEditorSnapshot(value: WorkEditorState) {
  return {
    work: pick(value.work, ['title', 'description', 'main_prompt', 'multichat_prompt', 'thumbnail_url', 'default_theme_id', 'default_theme_variant', 'visibility']),
    starts: value.starts.map(row => pick(row, ['id', 'name', 'initial_message', 'initial_context', 'keep_turns', 'is_default'])).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    keywords: value.keywords.map(row => pick(row, ['id', 'name', 'keywords', 'content', 'activation_turns'])).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };
}

/** A guarded replay can only acknowledge this exact saved snapshot. */
export async function saveWorkEditor(previous: WorkEditorState, next: WorkEditorState): Promise<void> {
  const args = { target_work: next.work.id, previous: workEditorSnapshot(previous), desired: workEditorSnapshot(next) };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase.rpc('save_work_editor', args);
    if (!error && data === true) return;
    if (error?.code === '40001') throw new Error('다른 화면에서 작품이 변경되었습니다. 수정 내용은 보존했으니 최신 작품과 비교해 주세요.');
    if (error?.code === 'PGRST202') throw new Error('작품 저장을 위한 서버 업데이트가 필요합니다. 수정 내용은 보존했습니다.');
    if (attempt || !/load failed|failed to fetch|networkerror|network request failed/i.test(error?.message ?? '')) throw error ?? new Error('저장 결과를 확인하지 못했습니다.');
  }
}
