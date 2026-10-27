import type { MultichatMember, MultichatRoom, Work } from '@/types/db';
import type { SystemParts } from './llm/types';

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
  const core = [config.system_prompt, config.multichat_system_prompt,
    work.main_prompt, work.multichat_prompt,
    'Always distinguish the participants by the names PC1 and PC2.']
    .filter(Boolean).map(multichatParticipantLabels).join('\n\n');
  const persona = [...members].sort((a, b) => a.slot - b.slot).map(member =>
    `PC${member.slot}: ${member.personas?.name || member.profiles?.display_name || `PC${member.slot}`}\n${member.personas?.description || ''}`,
  ).join('\n\n');
  return { core, persona, userNote: '', summary: '', keywords: '' };
}
