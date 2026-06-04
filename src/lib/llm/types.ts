import type { Provider } from '@/types/db';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateOptions {
  apiKey: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  maxOutputTokens: number | null;
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
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
    'anthropic/claude-sonnet-4.5',
    'anthropic/claude-3.5-haiku',
    'google/gemini-2.5-flash',
    'google/gemini-2.5-pro',
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
