import type { Provider } from '@/types/db';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SystemParts {
  core: string;      // 플랫폼 시스템 + 메인 프롬프트 (세션 내 불변)
  persona: string;   // 페르소나 (희소 변경)
  userNote: string;  // 유저 노트 (종종 변경)
  summary: string;   // 요약 히스토리 (재요약 시 변경)
  keywords: string;  // 활성 키워드북 (메시지마다 변경 — 캐싱 안 함)
}

export interface GenerateOptions {
  apiKey: string;
  model: string;
  systemParts: SystemParts;
  messages: ChatMessage[];
  maxOutputTokens: number | null;
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number; // 실제 청구 비용 (USD). OpenRouter만 제공, 그 외 0
}

export interface GenerateResult {
  text: string;
  usage: Usage;
}

export interface LLMAdapter {
  provider: Provider;
  generate(opts: GenerateOptions): Promise<GenerateResult>;
}

export const DEFAULT_MODELS: Record<Provider, string[]> = {
  openrouter: [
    'anthropic/claude-opus-4-8',
    'anthropic/claude-opus-4-7',
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-sonnet-4.5',
    'anthropic/claude-3.5-haiku',
    'google/gemini-2.5-pro',
    'google/gemini-pro-1.5',
    'google/gemini-2.5-flash',
    'openai/gpt-4o-mini',
    'openai/gpt-4o',
    'deepseek/deepseek-r1:free',
  ],
  claude: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-8'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  openai: ['gpt-4o-mini', 'gpt-4o'],
};

export const PROVIDER_LABELS: Record<Provider, string> = {
  openrouter: 'OpenRouter (통합)',
  claude: 'Claude (Anthropic)',
  gemini: 'Gemini (Google)',
  openai: 'GPT (OpenAI)',
};

