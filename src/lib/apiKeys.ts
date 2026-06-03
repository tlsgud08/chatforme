// API 키는 서버로 전송하지 않고 브라우저 localStorage 에만 저장한다.
import type { Provider } from '@/types/db';

const STORAGE_KEY = 'chatforme.apiKeys';

export type ApiKeys = Record<Provider, string>;

const EMPTY: ApiKeys = { openrouter: '', claude: '', gemini: '', openai: '' };

export function loadApiKeys(): ApiKeys {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<ApiKeys>;
    return { ...EMPTY, ...parsed };
  } catch {
    return { ...EMPTY };
  }
}

export function saveApiKeys(keys: ApiKeys): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

export function getApiKey(provider: Provider): string {
  return loadApiKeys()[provider] ?? '';
}

export function hasApiKey(provider: Provider): boolean {
  return getApiKey(provider).trim().length > 0;
}
