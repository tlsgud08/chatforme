import type { MultichatMember, MultichatRoom, Work } from '@/types/db';
import type { SystemParts } from './llm/types';

type Participants = readonly Pick<MultichatMember, 'slot' | 'profiles' | 'personas'>[];
export function multichatParticipantName(slot: number, members: Participants): string {
  const member = members.find(value => value.slot === slot);
  return member?.personas?.name || member?.profiles?.display_name || (slot === 1 ? '첫 번째 인물' : '두 번째 인물');
}

/** PC references identify characters in instructions, not their in-world names. */
export function resolveMultichatReferences(text: string, members: Participants): string {
  return text.replace(/\{\{\s*(?:pc|user)[ _]?([12])\s*\}\}|\b(?:pc|user)[ _]?([12])\b/gi,
    (_match, variable: string | undefined, reference: string | undefined) => multichatParticipantName(Number(variable ?? reference), members));
}

export function resolveMultichatVariables(text: string, members: Participants): string {
  return text.replace(/\{\{\s*(?:pc|user)[ _]?([12])\s*\}\}/gi,
    (_match, slot: string) => multichatParticipantName(Number(slot), members));
}

/** Old replies can contain input attribution markers; keep these out of prose. */
export function multichatNarrative(text: string, members: Participants): string {
  // A reference in an asset URL or code sample is not a character label.
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`]*`|https?:\/\/[^\s<>]+|<[^>]*>)/g)
    .map((part, index) => index % 2 ? part : resolveMultichatReferences(part.replace(/\(\s*PC[ _]?[12]\s*\)/gi, ''), members)).join('');
}

/** A retry or reroll keeps the payer assigned to its original round. */
export function multichatGenerationSlot(round: number, policy?: Pick<MultichatRoom, 'billing_mode' | 'billing_pc1_turns' | 'billing_pc2_turns' | 'billing_first_slot' | 'billing_start_round'> & Partial<Pick<MultichatRoom, 'progress_mode' | 'solo_slot' | 'current_round'>>): 1 | 2 {
  if (policy?.progress_mode === 'solo' && policy.solo_slot && round >= (policy.current_round ?? round)) return policy.solo_slot;
  if (policy?.billing_mode === 'pc1') return 1;
  if (policy?.billing_mode === 'pc2') return 2;
  const first = policy?.billing_first_slot ?? 1;
  const a = policy?.billing_pc1_turns ?? 1, b = policy?.billing_pc2_turns ?? 1;
  const offset = Math.max(0, round - (policy?.billing_start_round ?? 1)) % (a + b);
  return offset < (first === 1 ? a : b) ? first : first === 1 ? 2 : 1;
}

/** Keep existing rooms and saved prompt instructions compatible with PC labels. */
export function multichatParticipantLabels(text: string): string {
  return text.replace(/\buser([12])\b/gi, 'PC$1');
}

export function multichatSystemParts(
  config: { system_prompt: string; multichat_system_prompt: string },
  work: Pick<Work, 'main_prompt' | 'multichat_prompt'>,
  members: Pick<MultichatMember, 'slot' | 'profiles' | 'personas'>[],
): SystemParts {
  const core = [config.system_prompt, config.multichat_system_prompt, work.main_prompt, work.multichat_prompt].filter(Boolean).join('\n\n');
  const persona = [...members].sort((a, b) => a.slot - b.slot).map(member =>
    `PC${member.slot}: ${member.personas?.name || member.profiles?.display_name || `PC${member.slot}`}\n${member.personas?.description || ''}`,
  ).join('\n\n');
  return { core: resolveMultichatReferences(core, members) + '\n\nPC1 and PC2 are internal references only. Use the mapped character names in narration and dialogue; never print the internal labels.', persona, userNote: '', summary: '', keywords: '' };
}

export interface MultichatTurnState { progressMode: 'together' | 'solo'; activeSlot: 1 | 2 | null; }

/** Exact internal identifiers: a solo PC2 never becomes PC1 or a generic PC. */
export function applyMultichatTurnState(parts: SystemParts, state: MultichatTurnState): void {
  const active = state.progressMode === 'solo' ? `PC${state.activeSlot}` : 'PC1, PC2';
  if (state.progressMode === 'solo' && state.activeSlot !== 1 && state.activeSlot !== 2) throw new Error('혼자 진행할 PC를 확인해 주세요.');
  for (const key of Object.keys(parts) as (keyof SystemParts)[]) {
    const value = parts[key];
    if (typeof value === 'string') parts[key] = value.replace(/\{\{\s*multichat_mode\s*\}\}/g, state.progressMode).replace(/\{\{\s*multichat_active_pc\s*\}\}/g, active);
  }
  parts.keywords = [parts.keywords, `# Multichat Turn State\nmultichat_mode=${state.progressMode}\nmultichat_active_pc=${active}`].filter(Boolean).join('\n\n');
}

export function multichatRoundReady(room: Pick<MultichatRoom, 'current_round' | 'progress_mode' | 'solo_slot'>, submissions: readonly { round_number: number; slot: number; optimistic?: boolean }[]): boolean {
  const current = submissions.filter(s => !s.optimistic && s.round_number === room.current_round);
  return room.progress_mode === 'solo' ? current.length === 1 && current[0].slot === room.solo_slot : current.length === 2;
}
