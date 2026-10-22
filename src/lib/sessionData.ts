import { supabase } from './supabase';
import type { Message, Session } from '@/types/db';

export async function generationContext(session: Session, keywordTurns: number, reroll: boolean, signal?: AbortSignal): Promise<{ messages: Message[]; summary: string; summaryLastTurn: number }> {
  const request = supabase.rpc('session_generation_context', {
    target_session: session.id, after_summary: session.summary_last_turn,
    keyword_turns: keywordTurns, reroll,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  if (!data || !Array.isArray(data.messages)) throw new Error('대화 문맥을 불러오지 못했습니다.');
  return { messages: data.messages as Message[], summary: data.summary, summaryLastTurn: data.summaryLastTurn };
}

export async function selectResponse(sessionId: string, group: string, messageId: string, expected?: string): Promise<Session | null> {
  const { error } = await supabase.rpc('select_session_variant', {
    target_session: sessionId, target_group: group, target_message: messageId, expected_active: expected ?? null,
  });
  if (error) throw error;
  const { data } = await supabase.from('sessions').select('*').eq('id', sessionId).single();
  return data as Session | null;
}

export async function mutateSummary(sessionId: string, operation: 'edit' | 'delete' | 'select',
  versionId: string | null = null, text: string | null = null, selectedIds: string[] = []): Promise<Session> {
  const { data, error } = await supabase.rpc('mutate_session_summary', {
    target_session: sessionId, operation, target_version: versionId, summary_text: text, selected_ids: selectedIds,
  });
  if (error) throw error;
  if (!data) throw new Error('요약 저장 결과가 없습니다.');
  return data as Session;
}
