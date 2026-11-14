import type { Provider } from '@/types/db';

export interface LocalPreferences {
  provider: Provider;
  summaryProvider: 'default' | Provider;
  model: string;
  summaryModel: string;
  topP: number | null;
  sessionModels: Record<string, string>;
  sessionSummaryModels: Record<string, string>;
  sessionSummaryProviders: Record<string, 'default' | Provider>;
}
const DEFAULTS: LocalPreferences = { provider: 'openrouter', summaryProvider: 'default', model: '', summaryModel: '', topP: null, sessionModels: {}, sessionSummaryModels: {}, sessionSummaryProviders: {} };
const EVENT = 'inuchat:local-preferences';
const key = (userId: string) => `inuchat.local.${userId}`;
export function loadLocalPreferences(userId?: string): LocalPreferences {
  try {
    const data = JSON.parse(userId ? localStorage.getItem(key(userId)) ?? '{}' : '{}');
    return { provider: data.provider === 'local' ? 'local' : 'openrouter', model: typeof data.model === 'string' ? data.model : '',
      summaryProvider: data.summaryProvider === 'local' || data.summaryProvider === 'openrouter' ? data.summaryProvider : 'default',
      summaryModel: typeof data.summaryModel === 'string' ? data.summaryModel : '',
      topP: typeof data.topP === 'number' && data.topP >= 0 && data.topP <= 1 ? data.topP : null,
      sessionModels: data.sessionModels && typeof data.sessionModels === 'object' ? data.sessionModels : {},
      sessionSummaryModels: data.sessionSummaryModels && typeof data.sessionSummaryModels === 'object' ? data.sessionSummaryModels : {},
      sessionSummaryProviders: data.sessionSummaryProviders && typeof data.sessionSummaryProviders === 'object' ? data.sessionSummaryProviders : {} };
  } catch { return { ...DEFAULTS }; }
}
export function summaryProviderFor(userId?: string, sessionId = ''): Provider {
  const p = loadLocalPreferences(userId);
  const override = p.sessionSummaryProviders[sessionId];
  const selection = override === 'local' || override === 'openrouter' ? override : p.summaryProvider;
  return selection === 'default' ? p.provider : selection;
}
export function saveLocalPreferences(userId: string, patch: Partial<LocalPreferences>): void {
  localStorage.setItem(key(userId), JSON.stringify({ ...loadLocalPreferences(userId), ...patch }));
  window.dispatchEvent(new Event(EVENT));
}
export function localModelFor(userId: string | undefined, sessionId: string, summary = false): string {
  const p = loadLocalPreferences(userId);
  return summary ? p.sessionSummaryModels[sessionId] || p.summaryModel || p.sessionModels[sessionId] || p.model : p.sessionModels[sessionId] || p.model;
}
export function saveLocalSessionModel(userId: string, sessionId: string, model: string, summary = false): void {
  const field = summary ? 'sessionSummaryModels' : 'sessionModels';
  saveLocalPreferences(userId, { [field]: { ...loadLocalPreferences(userId)[field], [sessionId]: model } });
}
export function subscribeLocalPreferences(callback: () => void): () => void {
  window.addEventListener(EVENT, callback); window.addEventListener('storage', callback);
  return () => { window.removeEventListener(EVENT, callback); window.removeEventListener('storage', callback); };
}
