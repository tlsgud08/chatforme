import type { Provider } from '@/types/db';
import { defaultReasoningFor, modelsForProvider } from './llm/modelCapabilities';
import { loadOpenRouterModels } from './llm/modelDiscovery';
import type { ReasoningSelection } from './llm/types';

const CUSTOM_MODELS_KEY = 'inuchat.customModels';
const LEGACY_CUSTOM_MODELS_KEY = 'chatforme.customModels';
const DEFAULT_REASONING_KEY = 'inuchat.defaultReasoning';
const LEGACY_REASONING_KEY = 'chatforme.defaultReasoning';
const FAVORITE_MODELS_KEY = 'inuchat.favoriteModels';

export type CustomModels = Record<Provider, string[]>;
const EMPTY: CustomModels = { openrouter: [] };

const PROVIDER_PREFIX: Record<string, string> = {
  openai: 'openai', claude: 'anthropic', gemini: 'google',
};

/** Convert settings saved before the OpenRouter-only migration. */
export function toOpenRouterModel(provider: string | undefined, model: string): string {
  if (!model) return modelsFor('openrouter')[0];
  if (provider === 'openrouter' || model.includes('/')) return model;
  const prefix = provider ? PROVIDER_PREFIX[provider] : undefined;
  return prefix ? `${prefix}/${model}` : model;
}

export function loadCustomModels(): CustomModels {
  try {
    const stored = localStorage.getItem(CUSTOM_MODELS_KEY) ?? localStorage.getItem(LEGACY_CUSTOM_MODELS_KEY);
    if (stored && !localStorage.getItem(CUSTOM_MODELS_KEY)) localStorage.setItem(CUSTOM_MODELS_KEY, stored);
    return { ...EMPTY, ...JSON.parse(stored ?? '{}') };
  } catch {
    return { ...EMPTY };
  }
}

export function modelsFor(provider: Provider): string[] {
  return [...new Set([
    ...modelsForProvider(provider).map((item) => item.modelId),
    ...loadOpenRouterModels().map((model) => model.id),
    ...loadCustomModels()[provider],
  ])];
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

export function loadFavoriteModels(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(FAVORITE_MODELS_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((model): model is string => typeof model === 'string') : [];
  } catch {
    return [];
  }
}

export function toggleFavoriteModel(model: string): string[] {
  const favorites = loadFavoriteModels();
  const next = favorites.includes(model)
    ? favorites.filter((item) => item !== model)
    : [...favorites, model];
  localStorage.setItem(FAVORITE_MODELS_KEY, JSON.stringify(next));
  return next;
}

export function cacheFavoriteModels(models: string[]): string[] {
  const next = [...new Set(models.filter(Boolean))];
  localStorage.setItem(FAVORITE_MODELS_KEY, JSON.stringify(next));
  return next;
}

function migrateReasoning(value: unknown, provider: Provider, model: string): ReasoningSelection {
  if (value && typeof value === 'object') return value as ReasoningSelection;
  const defaults = defaultReasoningFor(provider, model);
  return typeof value === 'string' ? { ...defaults, effort: value } : defaults;
}

export function normalizeReasoning(value: unknown, provider: Provider, model: string): ReasoningSelection {
  const migrated = migrateReasoning(value, provider, model);
  const capability = modelsForProvider(provider).find((item) => item.modelId === model);
  if (!capability || (migrated.effort && !capability.supportedEfforts.includes(migrated.effort))) {
    return defaultReasoningFor(provider, model);
  }
  return { effort: migrated.effort };
}

export function loadDefaultReasoning(provider: Provider, model: string): ReasoningSelection {
  try {
    const raw = localStorage.getItem(DEFAULT_REASONING_KEY) ?? localStorage.getItem(LEGACY_REASONING_KEY);
    return normalizeReasoning(raw ? JSON.parse(raw) : null, provider, model);
  } catch {
    const legacy = localStorage.getItem(LEGACY_REASONING_KEY);
    return normalizeReasoning(legacy, provider, model);
  }
}

export function saveDefaultReasoning(value: ReasoningSelection): void {
  localStorage.setItem(DEFAULT_REASONING_KEY, JSON.stringify(value));
}
