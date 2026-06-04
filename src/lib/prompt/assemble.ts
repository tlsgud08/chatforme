import type { ChatMessage, SystemParts } from '@/lib/llm/types';
import type { Message, Persona } from '@/types/db';

export interface AssembleInput {
  systemPrompt: string;
  mainPrompt: string;
  keywordBookContents?: string[];
  summary?: string;
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
  if (input.mainPrompt.trim()) coreParts.push(section('작품 설정', input.mainPrompt));

  // L2: persona — 희소 변경
  let persona = '';
  if (input.persona && (input.persona.name || input.persona.description)) {
    persona = section('사용자 페르소나', `이름: ${input.persona.name}\n${input.persona.description}`);
  }

  // L3: userNote — 종종 변경
  let userNote = '';
  if (input.userNote && input.userNote.trim()) {
    userNote = section('유저 노트', input.userNote);
  }

  // L4: summary — 재요약 시 변경
  let summary = '';
  if (input.summary && input.summary.trim()) {
    summary = section('지난 줄거리 요약', input.summary);
  }

  // Dynamic: keywords — 메시지마다 변경, 캐싱 안 함
  let keywords = '';
  if (input.keywordBookContents && input.keywordBookContents.length > 0) {
    keywords = section('활성 키워드', input.keywordBookContents.join('\n\n'));
  }

  const messages: ChatMessage[] = [
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    ...(input.latestUserMessage ? [{ role: 'user' as const, content: input.latestUserMessage }] : []),
  ];

  return {
    systemParts: { core: coreParts.join('\n\n'), persona, userNote, summary, keywords },
    messages,
  };
}
