import type { ChatMessage } from '@/lib/llm/types';
import type { Message, Persona } from '@/types/db';

// 프롬프트 조립의 단일 진입점.
// 각 요소가 독립 슬롯이므로 키워드북/요약 메모리 등 추후 기능을 쉽게 끼워 넣을 수 있다.
export interface AssembleInput {
  systemPrompt: string;        // 전역 시스템 프롬프트 (platform_config)
  mainPrompt: string;          // 작품 메인 프롬프트
  keywordBookContents?: string[]; // 활성 키워드북 (Phase 2)
  summary?: string;            // 요약 메모리 (Phase 3)
  persona?: Pick<Persona, 'name' | 'description'> | null; // 페르소나 (Phase 2)
  userNote?: string;           // 세션별 유저 노트
  history: Pick<Message, 'role' | 'content'>[]; // 대화 히스토리(요약 미포함분)
  latestUserMessage: string;   // 최신 사용자 입력
}

export interface AssembledPrompt {
  system: string;
  messages: ChatMessage[];
}

function section(title: string, body: string): string {
  return `# ${title}\n${body.trim()}`;
}

export function assemblePrompt(input: AssembleInput): AssembledPrompt {
  const systemParts: string[] = [];

  if (input.systemPrompt.trim()) systemParts.push(input.systemPrompt.trim());
  if (input.mainPrompt.trim()) systemParts.push(section('작품 설정', input.mainPrompt));

  if (input.keywordBookContents && input.keywordBookContents.length > 0) {
    systemParts.push(section('활성 키워드', input.keywordBookContents.join('\n\n')));
  }

  if (input.summary && input.summary.trim()) {
    systemParts.push(section('지난 줄거리 요약', input.summary));
  }

  if (input.persona && (input.persona.name || input.persona.description)) {
    systemParts.push(
      section('사용자 페르소나', `이름: ${input.persona.name}\n${input.persona.description}`),
    );
  }

  if (input.userNote && input.userNote.trim()) {
    systemParts.push(section('유저 노트', input.userNote));
  }

  const messages: ChatMessage[] = [
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: input.latestUserMessage },
  ];

  return {
    system: systemParts.join('\n\n'),
    messages,
  };
}
