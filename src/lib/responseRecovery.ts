import { supabase } from './supabase';
import type { Message, Session } from '@/types/db';

export interface ResponseCommit {
  interrupted?: boolean;
  target_session: string; target_message: string; response_text: string;
  in_tokens: number; out_tokens: number; response_cost: number;
  read_tokens: number | null; write_tokens: number | null;
  target_group: string | null; previous_message: string | null;
  previous_summary: string; previous_summary_turn: number;
  restored_summary: string | null; restored_summary_turn: number | null; restored_versions: string[] | null;
}
export interface CommittedResponse { message: Message; session: Partial<Session>; contextConflict?: boolean; }
const memory = new Map<string, ResponseCommit>();
const key = (userId: string, sessionId: string) => `inuchat.pending-response.v1:${userId}:${sessionId}`;
export const isConnectionError = (error: unknown) => !!error && typeof error === 'object' && 'message' in error
  && /load failed|failed to fetch|networkerror|network request failed/i.test(String(error.message));

/** No credentials are stored. A pending answer belongs to one account and room. */
export function retainResponse(userId: string, args: ResponseCommit): boolean {
  const id = key(userId, args.target_session);
  memory.set(id, args);
  try { localStorage.setItem(id, JSON.stringify(args)); return true; } catch { return false; }
}
export function pendingResponse(userId: string, sessionId: string): ResponseCommit | null {
  const id = key(userId, sessionId);
  if (memory.has(id)) return memory.get(id)!;
  try {
    const parsed = JSON.parse(localStorage.getItem(id) ?? 'null');
    if (parsed?.target_session === sessionId && typeof parsed.target_message === 'string' && typeof parsed.response_text === 'string') return parsed;
  } catch { /* The in-memory copy survives blocked or full storage. */ }
  return memory.get(id) ?? null;
}
export function forgetResponse(userId: string, args: ResponseCommit): void {
  const id = key(userId, args.target_session);
  if (pendingResponse(userId, args.target_session)?.target_message !== args.target_message) return;
  memory.delete(id);
  try {
    if (JSON.parse(localStorage.getItem(id) ?? 'null')?.target_message === args.target_message) localStorage.removeItem(id);
  } catch { /* Never undo a confirmed server save. */ }
}

/** Replays only the same idempotent database commit, never a model request. */
export async function commitResponse(args: ResponseCommit): Promise<CommittedResponse> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { interrupted, ...finished } = args;
    const request = interrupted ? supabase.rpc('interrupt_session_response', {
      target_session: args.target_session, target_message: args.target_message, response_text: args.response_text,
      target_group: args.target_group, previous_message: args.previous_message,
    }) : supabase.rpc('finish_session_response', finished);
    const { data, error } = await request;
    if (!error && data?.message && data?.session) return data as CommittedResponse;
    const { data: row, error: readError } = await supabase.from('messages').select('*').eq('id', args.target_message).eq('session_id', args.target_session).maybeSingle();
    if (!readError && row && (row.usage_accounted || (args.interrupted && row.generation_status === 'interrupted' && row.content === args.response_text && (!args.target_group || row.is_active_variant || row.generation_context_conflict)))) {
      const { data: session } = await supabase.from('sessions').select('*').eq('id', args.target_session).single();
      return { message: row as Message, session: session ?? {}, contextConflict: row.generation_context_conflict === true };
    }
    if (attempt || !isConnectionError(error)) throw error ?? new Error('답변 저장을 확인하지 못했습니다.');
  }
  throw new Error('답변 저장을 확인하지 못했습니다.');
}

export async function beginResponse(args: {
  target_session: string; response_id: string; user_message_id: string | null;
  user_text: string; user_command_id: string | null; user_command_name: string | null; user_command_prompt: string | null;
  source_versions: { id: string; version: number; active: boolean }[];
  expected_summary: string; expected_summary_turn: number; reroll_message: string | null;
  requested_turn: number; requested_variant: number; expected_context_hash?: string;
}): Promise<{ draft: Message; userMessage: Message | null; replayed: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase.rpc('begin_session_response', args);
    if (!error && data?.draft?.id === args.response_id) return data;
    if (error?.code === '40001') throw new Error('다른 화면에서 대화가 변경되었거나 생성 중입니다. 입력은 보존했으니 대화를 다시 확인해 주세요.');
    if (error?.code === 'PGRST202') throw new Error('대화 저장을 위한 서버 업데이트가 필요합니다. 입력은 보존했습니다.');
    if (attempt || !isConnectionError(error)) throw error ?? new Error('응답 시작을 확인하지 못했습니다. 입력은 보존했습니다.');
  }
  throw new Error('응답 시작을 확인하지 못했습니다.');
}

export async function recoverExpiredResponses(sessionId: string): Promise<number> {
  const { data, error } = await supabase.rpc('recover_expired_session_responses', { target_session: sessionId });
  if (error) throw error;
  if (!Number.isInteger(data)) throw new Error('중단된 생성 상태를 확인하지 못했습니다.');
  return data as number;
}
