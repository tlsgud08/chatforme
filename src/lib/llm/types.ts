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
  reasoningEffort: ReasoningEffort;
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
}

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

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
    'openai/gpt-5.6-sol',
    'openai/gpt-5.6-terra',
    'openai/gpt-5.6-luna',
    'openai/gpt-5.5',
    'openai/gpt-5.5-pro',
    'openai/gpt-5.5-mini',
    'anthropic/claude-opus-4.8',
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-haiku-4.5',
    'google/gemini-3.1-pro-preview',
    'google/gemini-3-flash-preview',
    'google/gemini-2.5-pro',
    'google/gemini-2.5-flash',
  ],
  claude: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-6', 'claude-sonnet-4-5-20250929'],
  gemini: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  openai: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.5-mini'],
};

export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  none: '사용 안 함', low: '낮음', medium: '보통', high: '높음', xhigh: '최고',
};

export function reasoningOptions(provider: Provider, model: string): ReasoningEffort[] {
  const id = model.toLowerCase();
  if (provider === 'claude' || id.includes('anthropic/claude')) return ['none', 'low', 'medium', 'high'];
  if (provider === 'gemini' || id.includes('google/gemini')) return ['none', 'low', 'medium', 'high'];
  if (provider === 'openai' || id.includes('openai/gpt-5')) return ['none', 'low', 'medium', 'high', 'xhigh'];
  if (provider === 'openrouter') return ['none', 'low', 'medium', 'high'];
  return ['none'];
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  openrouter: 'OpenRouter (통합)',
  claude: 'Claude (Anthropic)',
  gemini: 'Gemini (Google)',
  openai: 'GPT (OpenAI)',
};
