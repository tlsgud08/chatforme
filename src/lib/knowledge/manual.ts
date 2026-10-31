import { supabase } from '../supabase';
import { loadWorkCombination } from '../workCombinationData';
import { multichatParticipantName } from '../multichat';
import { prepareKnowledge, type KnowledgeOptions } from './runtime';
import type { MultichatMember, Persona, Session, StartConfig, Work } from '@/types/db';

/** Read the same setup used by automatic extraction, including rooms with no user turn yet. */
export async function loadManualKnowledgeOptions(sessionId: string, apiKey: string, signal: AbortSignal): Promise<KnowledgeOptions> {
  signal.throwIfAborted();
  if (!apiKey.trim()) throw new Error('정보표를 생성하려면 OpenRouter API 키를 설정해 주세요.');
  const { data, error } = await supabase.from('sessions').select('*').eq('id', sessionId).abortSignal(signal).single();
  if (error || !data) throw error ?? new Error('채팅방 설정을 불러오지 못했습니다.');
  const session = data as Session;
  if (!session.knowledge_enabled) throw new Error('정보 접근 관리를 켠 뒤 생성해 주세요.');
  const multi = !!session.multichat_room_id;
  const [workResult, startResult, personaResult, membersResult] = await Promise.all([
    supabase.from('works').select('*').eq('id', session.work_id).abortSignal(signal).single(),
    session.start_config_id ? supabase.from('start_configs').select('*').eq('id', session.start_config_id).abortSignal(signal).single() : Promise.resolve({ data: null, error: null }),
    !multi && session.persona_id ? supabase.from('personas').select('*').eq('id', session.persona_id).abortSignal(signal).single() : Promise.resolve({ data: null, error: null }),
    multi ? supabase.from('multichat_members').select('*,profiles:public_profiles!multichat_members_public_profile_fk(display_name,avatar_url),personas(name,description)').eq('room_id', sessionId).order('slot').abortSignal(signal) : Promise.resolve({ data: [], error: null }),
  ]);
  signal.throwIfAborted();
  for (const result of [workResult, startResult, personaResult, membersResult]) if (result.error) throw result.error;
  if (!workResult.data) throw new Error('작품 설정을 불러오지 못했습니다.');
  const work = workResult.data as Work, start = startResult.data as StartConfig | null;
  const combination = await loadWorkCombination(session, work, signal);
  signal.throwIfAborted();
  const common = { sessionId, revision: session.knowledge_revision ?? 0, apiKey, signal };
  if (multi) {
    const members = membersResult.data as MultichatMember[];
    if (members.length !== 2) throw new Error('두 참여자의 설정을 불러오지 못했습니다.');
    return { ...common,
      // Match prepareMultichatContext byte-for-byte so manual work remains an automatic checkpoint.
      setup: JSON.stringify({ main: [work.main_prompt, work.multichat_prompt].join('\n\n'), combination, personas: members.map(m => ({ name: multichatParticipantName(m.slot, members), description: m.personas?.description ?? '' })), start: start?.initial_context ?? '' }),
      pcs: members.map(member => ({ name: multichatParticipantName(member.slot, members), aliases: [`PC${member.slot}`], pc: true })),
    };
  }
  const persona = personaResult.data as Persona | null;
  return { ...common,
    // Match ChatPage's original setup, including the activation-time persona fields.
    setup: JSON.stringify({ work: work.main_prompt, combination, persona, start: start?.initial_context ?? '' }),
    pcs: [{ name: persona?.name || 'PC', aliases: ['PC'], pc: true }],
  };
}

export async function generateKnowledgeNow(sessionId: string, apiKey: string, signal: AbortSignal, onProgress?: KnowledgeOptions['onProgress']) {
  const options = await loadManualKnowledgeOptions(sessionId, apiKey, signal);
  // Uses the automatic path's lease, source hashes and incremental checkpoints.
  return prepareKnowledge({ ...options, onProgress });
}
