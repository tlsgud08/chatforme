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
  storyNotes?: string;
  keywords: string;
}

export type PromptComponentStatus = 'CACHED' | 'PARTIAL' | 'UNCACHED';

export interface PromptDiagnosticComponent {
  key: string;
  label: string;
  estimatedTokens: number;
  fingerprint: string;
  change: 'SAME' | 'CHANGED' | 'NEW';
  cacheStatus: PromptComponentStatus;
}

export interface CacheDiagnostic {
  estimated: true;
  promptTokens: number;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadRatio: number | null;
  model: string;
  upstreamProvider: string | null;
  sessionId: string;
  requestId: string;
  generationId: string | null;
  historyChange: 'SAME' | 'CHANGED' | 'TRUNCATED' | 'EXTENDED' | 'NEW';
  components: PromptDiagnosticComponent[];
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
  cacheDiagnostic: CacheDiagnostic;
}

export interface LLMAdapter {
  provider: Provider;
  generate(opts: GenerateOptions): Promise<GenerateResult>;
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  openrouter: 'OpenRouter',
};
