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
export interface SemiContext {
  prompt: string;
  /** Current selected peer persona, independent of whether a summary was sent. */
  peer_persona: Pick<Persona, 'name' | 'description'> | null;
  peer: SemiSnapshot | null;
}

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
  const request = supabase.rpc('semi_session_context', { target_session: sessionId }, { get: true });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  if (!data) return null;
  if (typeof data.prompt !== 'string' || !('peer_persona' in data) || !('peer' in data)) throw new Error('세미 멀티챗 연결 정보를 불러오지 못했습니다.');
  return data as SemiContext;
}

/** PC is the current session; PC2 is always the peer, never a second user input. */
export function applySemiContext(assembled: AssembledPrompt, context: SemiContext | null): AssembledPrompt {
  if (!context) return assembled;
  const { peer, peer_persona: persona } = context;
  const personaBlock = `# PC2 Information\nPC2 Name: ${persona?.name ?? '페르소나 미선택'}\nPC2 Description: ${persona?.description ?? ''}`;
  const peerMemory = peer
    ? `# PC2 Sync Metadata\nSnapshot Persona Name: ${peer.persona?.name ?? '페르소나 미선택'}\nSynced At (real time): ${peer.sent_at}\nSource Session Turn: ${peer.through_turn}\n\n# PC2 Session Summary\n${peer.content}`
    : '# PC2 Session Summary\n[아직 전달받은 요약 없음]';
  return { ...assembled, systemParts: { ...assembled.systemParts,
    core: [assembled.systemParts.core, context.prompt].filter(Boolean).join('\n\n'),
    persona: [assembled.systemParts.persona, personaBlock].filter(Boolean).join('\n\n'),
    summary: [assembled.systemParts.summary, peerMemory].filter(Boolean).join('\n\n'),
  } };
}

export interface SemiPreparation { token: string; session: Session; persona: Pick<Persona, 'name' | 'description'> | null; }
