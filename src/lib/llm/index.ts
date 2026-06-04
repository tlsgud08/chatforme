import type { Provider } from '@/types/db';
import type { ChatMessage, GenerateOptions, GenerateResult, LLMAdapter } from './types';
import { claudeAdapter } from './claude';
import { geminiAdapter } from './gemini';
import { openaiAdapter } from './openai';
import { openrouterAdapter } from './openrouter';

const ADAPTERS: Record<Provider, LLMAdapter> = {
  openrouter: openrouterAdapter,
  claude: claudeAdapter,
  gemini: geminiAdapter,
  openai: openaiAdapter,
};

// 연속된 동일 role 메시지를 병합하고, 첫 메시지가 user임을 보장
function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const msg of messages) {
    if (result.length > 0 && result[result.length - 1].role === msg.role) {
      result[result.length - 1] = {
        ...result[result.length - 1],
        content: result[result.length - 1].content + '\n\n' + msg.content,
      };
    } else {
      result.push({ ...msg });
    }
  }
  if (result.length > 0 && result[0].role !== 'user') {
    result.unshift({ role: 'user', content: '(계속)' });
  }
  return result;
}

export function getAdapter(provider: Provider): LLMAdapter {
  return ADAPTERS[provider];
}

export async function generate(
  provider: Provider,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const normalized = normalizeMessages(opts.messages);
  return getAdapter(provider).generate({ ...opts, messages: normalized });
}

export * from './types';
