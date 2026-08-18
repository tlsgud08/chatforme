import type { Provider } from '@/types/db';
import { DEFAULT_MODELS, type ReasoningEffort } from './llm/types';

const CUSTOM_MODELS_KEY = 'chatforme.customModels';
const DEFAULT_REASONING_KEY = 'chatforme.defaultReasoning';

export type CustomModels = Record<Provider, string[]>;

const EMPTY: CustomModels = { openrouter: [], claude: [], gemini: [], openai: [] };

export function loadCustomModels(): CustomModels {
  try {
    return { ...EMPTY, ...JSON.parse(localStorage.getItem(CUSTOM_MODELS_KEY) ?? '{}') };
  } catch {
    return { ...EMPTY };
  }
}

export function modelsFor(provider: Provider): string[] {
  return [...new Set([...DEFAULT_MODELS[provider], ...loadCustomModels()[provider]])];
}

export function saveCustomModel(provider: Provider, model: string): void {
  const trimmed = model.trim();
  if (!trimmed) return;
  const all = loadCustomModels();
  all[provider] = [...new Set([...all[provider], trimmed])];
  localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(all));
}

export function removeCustomModel(provider: Provider, model: string): void {
  const all = loadCustomModels();
  all[provider] = all[provider].filter((item) => item !== model);
  localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(all));
}

export function loadDefaultReasoning(): ReasoningEffort {
  return (localStorage.getItem(DEFAULT_REASONING_KEY) as ReasoningEffort | null) ?? 'none';
}

export function saveDefaultReasoning(value: ReasoningEffort): void {
  localStorage.setItem(DEFAULT_REASONING_KEY, value);
}
