import { supabase } from './supabase';
import type { Persona, Session } from '@/types/db';
import type { AssembledPrompt } from './prompt/assemble';

export interface SemiSnapshot {
  content: string;
  persona: Pick<Persona, 'name' | 'description'>;
  sent_at: string;
  through_turn: number;
}
export interface SemiLink {
  id: string; user_a: string; user_b: string; session_a: string; session_b: string | null;
  title_a: string; title_b: string | null; status: 'pending' | 'active' | 'closed';
  snapshot_a: SemiSnapshot | null; snapshot_b: SemiSnapshot | null;
}
export interface SemiContext { prompt: string; peer: SemiSnapshot | null; }

export async function semiAction(operation: 'request' | 'accept' | 'close' | 'prepare' | 'publish' | 'release', sessionId: string, linkId?: string, details?: Record<string, unknown>, otherUser?: string) {
  const args = {
    operation, target_session: sessionId, target_link: linkId ?? null, other_user: otherUser ?? null, details: details ?? {},
  };
  let { data, error } = await supabase.rpc('semi_session_action', args);
  if (operation === 'publish' && error && /load failed|failed to fetch|networkerror|network request failed/i.test(error.message)) {
    ({ data, error } = await supabase.rpc('semi_session_action', args));
  }
  if (error) throw error;
  if (data == null) throw new Error('세션 연동 결과를 확인하지 못했습니다.');
  return data;
}

export async function loadSemiLinks(signal?: AbortSignal): Promise<SemiLink[]> {
  let query = supabase.from('semi_session_links').select('id,user_a,user_b,session_a,session_b,title_a,title_b,status,snapshot_a,snapshot_b').neq('status', 'closed');
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as SemiLink[];
}

/** Re-read on each model request. Unlinking never depends on a stale sidebar. */
export async function loadSemiContext(sessionId: string, signal?: AbortSignal): Promise<SemiContext | null> {
  let query = supabase.from('semi_session_links').select('session_a,snapshot_a,snapshot_b').eq('status', 'active').or(`session_a.eq.${sessionId},session_b.eq.${sessionId}`);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) return null;
  let config = supabase.from('platform_config').select('semi_multichat_prompt').eq('id', 1);
  if (signal) config = config.abortSignal(signal);
  const result = await config.single();
  if (result.error || typeof result.data?.semi_multichat_prompt !== 'string') throw result.error ?? new Error('세미 멀티챗 프롬프트를 불러오지 못했습니다.');
  return { prompt: result.data.semi_multichat_prompt, peer: (data.session_a === sessionId ? data.snapshot_b : data.snapshot_a) as SemiSnapshot | null };
}

/** PC is the current session; PC2 is always the peer, never a second user input. */
export function applySemiContext(assembled: AssembledPrompt, context: SemiContext | null): AssembledPrompt {
  if (!context) return assembled;
  const { peer } = context;
  return { ...assembled, systemParts: { ...assembled.systemParts,
    core: [assembled.systemParts.core, context.prompt].filter(Boolean).join('\n\n'),
    persona: [assembled.systemParts.persona, peer ? `# PC2 Information\nPC2 Name: ${peer.persona?.name ?? ''}\nPC2 Description: ${peer.persona?.description ?? ''}` : ''].filter(Boolean).join('\n\n'),
    summary: [assembled.systemParts.summary, peer ? `# PC2 Session Summary\n${peer.content}` : ''].filter(Boolean).join('\n\n'),
  } };
}

export interface SemiPreparation { token: string; session: Session; }
