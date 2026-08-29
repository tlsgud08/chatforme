import type { ChatMessage, SystemParts } from '@/lib/llm/types';
import type { Message, Persona } from '@/types/db';

export interface AssembleInput {
  systemPrompt: string;
  mainPrompt: string;
  keywordBookContents?: string[];
  summary?: string;
  storyNotes?: string[];
  persona?: Pick<Persona, 'name' | 'description'> | null;
  userNote?: string;
  history: Pick<Message, 'role' | 'content'>[];
  latestUserMessage: string;
}

export interface AssembledPrompt {
  systemParts: SystemParts;
  messages: ChatMessage[];
}

function section(title: string, body: string): string {
  return `# ${title}\n${body.trim()}`;
}

export function assemblePrompt(input: AssembleInput): AssembledPrompt {
  // L1: core — 플랫폼 시스템 + 메인 프롬프트 (세션 내 불변)
  const coreParts: string[] = [];
  if (input.systemPrompt.trim()) coreParts.push(input.systemPrompt.trim());
  if (input.mainPrompt.trim()) coreParts.push(section('Main Prompt', input.mainPrompt));

  // L2: persona — 희소 변경
  let persona = '';
  if (input.persona && (input.persona.name || input.persona.description)) {
    persona = section(
      '{PC} Information',
      `{PC} = ${input.persona.name}\n{PC} Name: ${input.persona.name}\n{PC} Description: ${input.persona.description}`,
    );
  }

  // L3: userNote — 종종 변경
  let userNote = '';
  if (input.userNote && input.userNote.trim()) {
    userNote = section('User Notes', input.userNote);
  }

  // L4: summary — 재요약 시 변경
  const summary = input.summary?.trim() ? section('Previous Story Summary', input.summary) : '';
  const storyNotes = input.storyNotes?.length
    ? section('Story Notes', input.storyNotes.join('\n\n'))
    : '';

  // Dynamic: keywords — 메시지마다 변경, 캐싱 안 함
  let keywords = '';
  if (input.keywordBookContents && input.keywordBookContents.length > 0) {
    keywords = section('Active Keywords', input.keywordBookContents.join('\n\n'));
  }

  const messages: ChatMessage[] = [
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    ...(input.latestUserMessage ? [{ role: 'user' as const, content: input.latestUserMessage }] : []),
  ];

  return {
    systemParts: { core: coreParts.join('\n\n'), persona, userNote, summary, storyNotes, keywords },
    messages,
  };
}
