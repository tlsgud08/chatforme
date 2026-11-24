import { fromMarkdown } from 'mdast-util-from-markdown';
import type { RootContent } from 'mdast';
import type { Message } from '@/types/db';
import { supabase } from './supabase';
import type { PersonaDeathContext } from './personaDeathPrompt';

export interface DeathStatusChoice {
  id: string;
  messageId: string;
  messageVersion: number;
  turn: number;
  label: string;
  preview: string;
  raw: string;
}

export function deathStatusChoices(messages: Message[]): DeathStatusChoice[] {
  return [...messages].reverse().flatMap(message => {
    const version = message.content_version;
    if (message.is_hidden || message.is_active_variant === false || message.generation_status === 'streaming'
      || version === undefined || !Number.isSafeInteger(version)) return [];
    const choices: DeathStatusChoice[] = [];
    function visit(node: RootContent) {
      if (node.type === 'code' && node.position && node.value.trim()) {
        const { start, end } = node.position;
        if (start.offset === undefined || end.offset === undefined) return;
        choices.push({
          id: message.id + ':' + start.offset,
          messageId: message.id,
          messageVersion: version!,
          turn: message.turn_index,
          label: node.lang || '코드블록',
          preview: node.value,
          raw: message.content.slice(start.offset, end.offset),
        });
      }
      if ('children' in node) node.children.forEach(visit);
    }
    fromMarkdown(message.content).children.forEach(visit);
    return choices.reverse();
  });
}

export async function loadPersonaDeathContext(sessionId: string, signal: AbortSignal): Promise<PersonaDeathContext> {
  const { data, error } = await supabase.rpc('session_persona_death_context', { target_session: sessionId }, { get: true }).abortSignal(signal);
  if (error) throw error;
  if (!data || !Array.isArray(data.deaths)) throw new Error('페르소나 사망 기록을 불러오지 못했습니다.');
  return data as PersonaDeathContext;
}

export async function recordPersonaDeath(
  sessionId: string, personaId: string, nextPersonaId: string | null,
  status: DeathStatusChoice | undefined, note: string, requestId: string,
): Promise<PersonaDeathContext> {
  const args = {
    target_session: sessionId, expected_persona: personaId, next_persona: nextPersonaId,
    request_id: requestId, death_note: note, status_block: status?.raw ?? null,
    status_message: status?.messageId ?? null, status_version: status?.messageVersion ?? null,
  };
  let { data, error } = await supabase.rpc('record_session_persona_death', args);
  if (error && /load failed|failed to fetch|networkerror|network request failed/i.test(error.message)) {
    ({ data, error } = await supabase.rpc('record_session_persona_death', args));
  }
  if (error) throw error;
  if (!data || !Array.isArray(data.deaths)) throw new Error('사망 처리 결과를 확인하지 못했습니다.');
  return data as PersonaDeathContext;
}
