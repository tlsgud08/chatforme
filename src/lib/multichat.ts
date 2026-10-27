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
export function multichatGenerationSlot(round: number, policy?: Pick<MultichatRoom, 'billing_mode' | 'billing_pc1_turns' | 'billing_pc2_turns' | 'billing_first_slot' | 'billing_start_round'>): 1 | 2 {
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
