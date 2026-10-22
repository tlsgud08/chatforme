import type { Work } from '@/types/db';

export const DEFAULT_WORK_COMBINATION_PROMPT = '아래 작품들은 하나의 대화에 함께 적용된다. 설정이나 지시가 충돌하면 메인 작품을 최우선으로 따르고, 추가 작품은 지정된 우선순위에 따른다. 충돌하지 않는 설정은 함께 적용한다. 우선순위가 낮다는 이유만으로 해당 작품의 인물이나 설정을 생략하지 않는다.';

export type CombinedWork = Pick<Work, 'id' | 'title' | 'main_prompt'>;
export type CombinationWorkInfo = Pick<Work, 'id' | 'title' | 'description'>;

export interface WorkCombinationPrompt {
  enabled: boolean;
  mainWorkId: string;
  mainWorkTitle: string;
  instruction: string;
  works: CombinedWork[];
}

/** Validate rather than silently dropping malformed entries or changing priority. */
export function combinedWorkIds(value: unknown, mainWorkId: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('작품 결합 목록이 올바르지 않습니다. 세션 메뉴에서 다시 설정해 주세요.');
  const ids: string[] = [];
  const seen = new Set<string>([mainWorkId.toLowerCase()]);
  for (const entry of value) {
    if (typeof entry !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry)) {
      throw new Error('작품 결합 목록에 올바르지 않은 작품이 있습니다.');
    }
    const id = entry.toLowerCase();
    if (seen.has(id)) throw new Error('메인 작품이나 같은 작품을 중복해서 결합할 수 없습니다.');
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n]/g, ' ');
}

/** Null means take the original assembly path, with no extra headings or whitespace. */
export function workCombinationPrompt(mainPrompt: string, combination?: WorkCombinationPrompt): string | null {
  if (!combination?.enabled || combination.works.length === 0) return null;
  combinedWorkIds(combination.works.map(work => work.id), combination.mainWorkId);
  if (combination.works.some(work => !work.main_prompt.trim())) {
    throw new Error('메인 프롬프트가 비어 있는 추가 작품이 있습니다. 세션 메뉴에서 제외해 주세요.');
  }
  const parts: string[] = [];
  // An intentionally empty admin instruction stays empty; no hidden fallback.
  if (combination.instruction.trim()) parts.push(`# Work Combination Rules\n${combination.instruction}`);
  parts.push(`# Main Prompt\n<main_work title="${attribute(combination.mainWorkTitle)}" priority="highest">\n${mainPrompt}\n</main_work>`);
  combination.works.forEach((work, index) => {
    parts.push(`<additional_work title="${attribute(work.title)}" priority="${index + 1}">\n${work.main_prompt}\n</additional_work>`);
  });
  return parts.join('\n\n');
}
