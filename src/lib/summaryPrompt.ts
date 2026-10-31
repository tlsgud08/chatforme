import { supabase } from './supabase';
import type { Profile, Session } from '@/types/db';

/** Keep the shared prompt intact and append the original per-user/room controls. */
export function summaryPromptWithParameters(prompt: string, profile: Partial<Profile>, session: Partial<Session>): string {
  const level = session.summary_level_override ?? profile.summary_level ?? 5;
  const omission = session.summary_allow_omission_override ?? profile.summary_allow_omission ?? true;
  const enabled = session.summary_parameters_enabled_override ?? profile.summary_parameters_enabled ?? true;
  const parameters = enabled ? `[SUMMARY CONFIGURATION]\nSUMMARY_LEVEL = ${level}\nALLOW_OMISSION = ${omission ? 'ON' : 'OFF'}` : '';
  const note = profile.summary_extra_note?.trim();
  return [prompt, parameters, note ? `[ADDITIONAL NOTE]\n${note}` : ''].filter(Boolean).join('\n\n');
}

/** Always fetch the administrator's global instruction; no personal/local fallback. */
export async function loadGlobalSummaryPrompt(signal?: AbortSignal): Promise<string> {
  let query = supabase.from('platform_config').select('summary_prompt').eq('id', 1);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query.single();
  if (error) throw error;
  if (typeof data?.summary_prompt !== 'string' || !data.summary_prompt.trim()) throw new Error('전역 요약 프롬프트를 불러오지 못했습니다. 관리자 설정을 확인해 주세요.');
  return data.summary_prompt;
}

/** Sync exports have their own administrator instruction; never fall back to ordinary summaries. */
export async function loadSemiSyncSummaryPrompt(signal?: AbortSignal): Promise<string> {
  let query = supabase.from('platform_config').select('semi_sync_summary_prompt').eq('id', 1);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query.single();
  if (error) throw error;
  if (typeof data?.semi_sync_summary_prompt !== 'string' || !data.semi_sync_summary_prompt.trim()) throw new Error('동기화용 요약 프롬프트를 불러오지 못했습니다. 관리자 설정을 확인해 주세요.');
  return data.semi_sync_summary_prompt;
}
