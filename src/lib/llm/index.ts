import type { Provider } from '@/types/db';
import type { GenerateOptions, GenerateResult, LLMAdapter } from './types';
import { claudeAdapter } from './claude';
import { geminiAdapter } from './gemini';
import { openaiAdapter } from './openai';

const ADAPTERS: Record<Provider, LLMAdapter> = {
  claude: claudeAdapter,
  gemini: geminiAdapter,
  openai: openaiAdapter,
};

export function getAdapter(provider: Provider): LLMAdapter {
  return ADAPTERS[provider];
}

export async function generate(
  provider: Provider,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  return getAdapter(provider).generate(opts);
}

export * from './types';
