import type { MultichatMember, Work } from '@/types/db';
import type { SystemParts } from './llm/types';

/** A retry or reroll keeps the payer assigned to its original round. */
export function multichatGenerationSlot(round: number): 1 | 2 {
  return round % 2 === 0 ? 2 : 1;
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
