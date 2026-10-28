import { supabase } from './supabase';

/** Always fetch the administrator's global instruction; no personal/local fallback. */
export async function loadGlobalSummaryPrompt(signal?: AbortSignal): Promise<string> {
  let query = supabase.from('platform_config').select('summary_prompt').eq('id', 1);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query.single();
  if (error) throw error;
  if (typeof data?.summary_prompt !== 'string' || !data.summary_prompt.trim()) throw new Error('전역 요약 프롬프트를 불러오지 못했습니다. 관리자 설정을 확인해 주세요.');
  return data.summary_prompt;
}
