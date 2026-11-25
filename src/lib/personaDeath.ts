import { fromMarkdown } from 'mdast-util-from-markdown';
import type { RootContent } from 'mdast';
import type { Message } from '@/types/db';
import { supabase } from './supabase';
import type { PersonaArchiveContext } from './personaDeathPrompt';

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

export async function loadPersonaArchiveContext(sessionId: string, signal: AbortSignal): Promise<PersonaArchiveContext> {
  const { data, error } = await supabase.rpc('session_persona_archive_context', { target_session: sessionId }, { get: true }).abortSignal(signal);
  if (error) throw error;
  if (!data || !Array.isArray(data.archives)) throw new Error('페르소나 보관 기록을 불러오지 못했습니다.');
  return data as PersonaArchiveContext;
}

export async function loadPersonaStatusTurn(sessionId: string, turn: number, signal?: AbortSignal): Promise<DeathStatusChoice | undefined> {
  const request = supabase.rpc('session_persona_status_turn', { target_session: sessionId, target_turn: turn }, { get: true });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('상태창을 불러오지 못했습니다.');
  return deathStatusChoices(data as Message[])[0];
}

export function parsePersonaImageLink(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    if (/^https?:\/\/[^\s<>]+$/i.test(trimmed)) {
      const url = new URL(trimmed);
      if (url.href.length <= 2048 && !url.username && !url.password) return url.href;
    }
  } catch {
    // Invalid URL input is handled with the same validation message below.
  }
  throw new Error('HTTP 또는 HTTPS 이미지 링크 한 개를 입력해 주세요.');
}

export type StatusArchiveSelection = { type: 'keep' | 'remove' } | { type: 'replace'; status: DeathStatusChoice };

export interface PersonaArchiveChange {
  living: boolean;
  mayAppear: boolean;
  imageUrl: string | null;
  note: string;
  status: StatusArchiveSelection;
}

export async function mutatePersonaArchive(
  sessionId: string, personaId: string, operation: 'create' | 'edit' | 'delete', nextPersona: string | null,
  revision: string | null, requestId: string, change?: PersonaArchiveChange,
): Promise<PersonaArchiveContext> {
  const status = change?.status.type === 'replace' ? change.status.status : undefined;
  const args = {
    target_session: sessionId, target_persona: personaId, operation, mutation_id: requestId,
    expected_revision: revision, next_persona: nextPersona,
    changes: change ? {
      is_living: change.living, may_appear: change.mayAppear, image_url: change.imageUrl, note: change.note,
      status_action: change.status.type, status_block: status?.raw, status_message: status?.messageId,
      status_version: status?.messageVersion,
    } : null,
  };
  const submit = () => supabase.rpc('mutate_session_persona_archive', args);
  let { data, error } = await submit();
  if (error && /load failed|failed to fetch|networkerror|network request failed/i.test(error.message)) {
    ({ data, error } = await submit());
  }
  if (error) throw error;
  if (!data || !Array.isArray(data.archives)) throw new Error('보관 기록 저장 결과를 확인하지 못했습니다.');
  return data as PersonaArchiveContext;
}
