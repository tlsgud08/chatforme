import type { Persona } from '@/types/db';

export const DEFAULT_PERSONA_TRANSITION_TEMPLATE =
  '페르소나(플레이어 캐릭터)가 {이전}에서 {현재}로 전환되었습니다. 해당 사실을 반영하여 진행해 주세요.';

export interface PersonaTurnContext {
  persona: Persona | null;
  notice: { from: string; to: string; template: string } | null;
}

export function appendPersonaTransition(text: string, notice: PersonaTurnContext['notice']): string {
  if (!notice) return text;
  const template = notice.template.trim() || DEFAULT_PERSONA_TRANSITION_TEMPLATE;
  const message = template.replace(/\{이전\}|\{현재\}/g, match => match === '{이전}' ? notice.from : notice.to);
  return text ? text + '\n\n*' + message + '*' : '*' + message + '*';
}
