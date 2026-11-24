import type { AssembledPrompt } from './prompt/assemble';
import type { Persona } from '@/types/db';

export const DEFAULT_PERSONA_DEATH_PROMPT =
  '아래에 기록된 PC들은 사망 상태입니다. 이들이 세계에 남긴 영향과 NPC와 맺었던 관계, 사건의 결과를 이후 전개에도 보존하세요. 현재 PC는 별도의 {PC} Information에 따라 다루고, 사망한 PC를 현재 PC로 취급하거나 임의로 되살리지 마세요. 사망 당시 프롬프트와 상태창, 메모는 과거 인물의 기록으로 참고하세요.';

export interface PersonaDeathRecord {
  persona_id: string;
  persona_name: string;
  persona_description: string;
  status_block: string | null;
  death_note: string;
}

export interface PersonaDeathContext {
  persona: Persona | null;
  deaths: PersonaDeathRecord[];
  prompt: string;
}

function snapshot(label: string, value: string): string {
  // Pick a fence longer than any run in the source to preserve it verbatim.
  const fenceLength = (value.match(/~+/g) ?? []).reduce((length, run) => Math.max(length, run.length + 1), 3);
  const fence = '~'.repeat(fenceLength);
  return label + '\n' + fence + '\n' + value + '\n' + fence;
}

export function applyPersonaDeaths(prompt: AssembledPrompt, context: PersonaDeathContext | null): AssembledPrompt {
  if (!context?.deaths.length) return prompt;
  const records = context.deaths.map(death => [
    snapshot('사망한 PC 이름', death.persona_name),
    snapshot('사망 당시 페르소나 프롬프트', death.persona_description),
    ...(death.status_block === null ? [] : [snapshot('사망 당시 상태창', death.status_block)]),
    ...(death.death_note.trim() ? [snapshot('사망 메모', death.death_note)] : []),
  ].join('\n'));
  const personaDeaths = ['# Persona Death Records', context.prompt.trim() || DEFAULT_PERSONA_DEATH_PROMPT, ...records].join('\n\n');
  return { ...prompt, systemParts: { ...prompt.systemParts, personaDeaths } };
}
