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

export const DEFAULT_PERSONA_LIVING_ARCHIVE_PROMPT =
  '보관된 인물은 살아 있으며 기존 관계와 행적의 영향을 유지한다. 등장 가능이면 장면에 어울릴 때 AI가 NPC로 등장시키고, 유저노트와 해당 인물의 과거 발화에 맞춰 성격·말투·행동을 이어간다. 등록된 이미지는 실제 등장 장면에 필요할 때만 사용한다. 등장 불가이면 간접 언급과 영향만 반영하며 전화, 메시지, 회상 등을 포함해 직접 등장이나 새 대사·행동을 만들지 않는다.';

export interface PersonaArchiveRecord {
  persona_id: string;
  persona_name: string;
  persona_description: string;
  status_block: string | null;
  status_turn: number | null;
  note: string;
  is_living: boolean;
  may_appear: boolean;
  image_url: string | null;
  revision: string;
  past_lines?: string[];
}

export interface PersonaArchiveContext {
  persona: Persona | null;
  archives: PersonaArchiveRecord[];
  deathPrompt: string;
  livingPrompt: string;
}

export function statusTurnLabel(turn: number | null): string {
  return turn === null ? '상태창' : '상태창 ' + String(turn).padStart(2, '0') + '턴';
}

export function applyPersonaArchives(prompt: AssembledPrompt, context: PersonaArchiveContext): AssembledPrompt {
  const deceased = context.archives.filter(record => !record.is_living);
  const living = context.archives.filter(record => record.is_living);
  const render = (record: PersonaArchiveRecord) => [
    snapshot(record.is_living ? '생존 보관된 인물 이름' : '사망한 PC 이름', record.persona_name),
    ...(record.is_living ? [record.may_appear
      ? 'RP 등장 가능. 이 인물의 역할은 NPC다.'
      : 'RP 등장 불가. 생존 상태로 간접 언급과 영향만 허용하며 직접 등장·대사·행동은 금지한다.'] : []),
    snapshot('보관 당시 페르소나 프롬프트', record.persona_description),
    ...(record.status_block === null ? [] : [snapshot(statusTurnLabel(record.status_turn), record.status_block)]),
    ...(record.note.trim() ? [snapshot(record.is_living ? '보관 메모' : '사망 메모', record.note)] : []),
    ...(record.past_lines?.length && record.is_living && record.may_appear
      ? [snapshot('해당 인물의 과거 발화·행동', record.past_lines.join('\n\n'))] : []),
    ...(record.is_living && record.may_appear && record.image_url
      ? [record.persona_name.replace(/\s+/g, ' ') + '의 이미지: ![](' + record.image_url.replace(/\(/g, '%28').replace(/\)/g, '%29') + ')'] : []),
  ].join('\n');
  const blocks = [
    ...(deceased.length ? ['# Persona Death Records', context.deathPrompt.trim() || DEFAULT_PERSONA_DEATH_PROMPT, ...deceased.map(render)] : []),
    ...(living.length ? ['# Living Persona Archives', context.livingPrompt.trim() || DEFAULT_PERSONA_LIVING_ARCHIVE_PROMPT, ...living.map(render)] : []),
  ];
  return blocks.length ? { ...prompt, systemParts: { ...prompt.systemParts, personaDeaths: blocks.join('\n\n') } } : prompt;
}
