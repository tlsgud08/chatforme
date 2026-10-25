import { supabase } from './supabase';
import type { Message, Session } from '@/types/db';

export interface MessagePage { messages: Message[]; hasOlder: boolean; oldestTurn: number | null; totalUserTurns: number; }

export function mergeLatestPage(current: Message[], page: MessagePage, previous: Pick<MessagePage, 'oldestTurn' | 'hasOlder'>): MessagePage {
  const older = current.filter(message => page.oldestTurn !== null && message.turn_index < page.oldestTurn);
  const connected = older.length > 0 && current.some(message => message.turn_index >= page.oldestTurn! - 1);
  return { ...page, messages: [...older, ...page.messages],
    ...(connected ? { hasOlder: previous.hasOlder, oldestTurn: previous.oldestTurn } : {}) };
}

export async function fetchMessagePage(sessionId: string, before?: number, signal?: AbortSignal): Promise<MessagePage> {
  // Both read RPCs are STABLE/SECURITY INVOKER. GET retains the SDK's bounded
  // network retries; POST RPCs are deliberately not retried by the locked SDK.
  const request = supabase.rpc('session_message_page', {
    target_session: sessionId, before_turn: before,
  }, { get: true });
  // Omit an absent cursor: GET would encode null as the invalid integer "null".
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  if (!data || !Array.isArray(data.messages)) throw new Error('메시지 목록을 불러오지 못했습니다.');
  return data as MessagePage;
}

export async function generationContext(session: Session, keywordTurns: number, reroll: boolean, signal?: AbortSignal): Promise<{ messages: Message[]; summary: string; summaryLastTurn: number }> {
  const request = supabase.rpc('session_generation_context', {
    target_session: session.id, after_summary: session.summary_last_turn,
    keyword_turns: keywordTurns, reroll,
  }, { get: true });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  if (!data || !Array.isArray(data.messages)) throw new Error('대화 문맥을 불러오지 못했습니다.');
  return { messages: data.messages as Message[], summary: data.summary, summaryLastTurn: data.summaryLastTurn };
}

export async function selectResponse(sessionId: string, group: string, messageId: string, expected?: string): Promise<Session | null> {
  const { error } = await supabase.rpc('select_session_variant', {
    target_session: sessionId, target_group: group, target_message: messageId, expected_active: expected ?? null,
  });
  if (error) {
    if (!/load failed|failed to fetch|networkerror/i.test(error.message ?? '')) throw error;
    const { data: selected, error: readError } = await supabase.from('messages').select('id,is_active_variant')
      .eq('id', messageId).eq('session_id', sessionId).maybeSingle();
    if (readError || !selected?.is_active_variant) throw error;
  }
  const { data, error: sessionError } = await supabase.from('sessions').select('*').eq('id', sessionId).single();
  if (sessionError) throw sessionError;
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

export async function branchSession(message: Message): Promise<string> {
  if (!Number.isSafeInteger(message.content_version)) throw new Error('메시지 버전을 확인하지 못했습니다. 대화를 다시 불러와 주세요.');
  const id = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase.rpc('branch_session_at_message', {
      target_session: message.session_id, target_message: message.id, branch_id: id, expected_version: message.content_version!,
    });
    if (!error && data === id) return id;
    if (!/load failed|failed to fetch|networkerror|network request failed/i.test(error?.message ?? '')) throw error ?? new Error('분기 결과를 확인하지 못했습니다.');
    const { data: saved, error: readError } = await supabase.from('sessions').select('id').eq('id', id).maybeSingle();
    if (!readError && saved?.id === id) return id;
    if (readError || attempt === 1) throw new Error('분기 저장 여부를 확인하지 못했습니다. 채팅방 목록을 확인해 주세요.');
  }
  throw new Error('분기 결과를 확인하지 못했습니다.');
}
