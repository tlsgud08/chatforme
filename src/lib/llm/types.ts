import type { Provider } from '@/types/db';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SystemParts {
  core: string;
  persona: string;
  userNote: string;
  summary: string;
  keywords: string;
}

/** Native provider values. An effort with the same label is not comparable across providers. */
export interface ReasoningSelection {
  effort?: string;
  mode?: string;
}

export interface GenerateOptions {
  apiKey: string;
  model: string;
  /** Stable conversation identifier. OpenRouter accepts at most 64 characters here. */
  sessionId: string;
  systemParts: SystemParts;
  messages: ChatMessage[];
  maxOutputTokens: number | null;
  reasoning: ReasoningSelection;
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  cost: number;
}

export interface GenerateResult {
  text: string;
  usage: Usage;
}

export interface LLMAdapter {
  provider: Provider;
  generate(opts: GenerateOptions): Promise<GenerateResult>;
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  openrouter: 'OpenRouter',
};
