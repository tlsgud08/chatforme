import type { Provider } from '@/types/db';

export interface LocalPreferences {
  provider: Provider;
  model: string;
  summaryModel: string;
  topP: number | null;
  sessionModels: Record<string, string>;
  sessionSummaryModels: Record<string, string>;
}
const DEFAULTS: LocalPreferences = { provider: 'openrouter', model: '', summaryModel: '', topP: null, sessionModels: {}, sessionSummaryModels: {} };
const EVENT = 'inuchat:local-preferences';
const key = (userId: string) => `inuchat.local.${userId}`;
export function loadLocalPreferences(userId?: string): LocalPreferences {
  try {
    const data = JSON.parse(userId ? localStorage.getItem(key(userId)) ?? '{}' : '{}');
    return { provider: data.provider === 'local' ? 'local' : 'openrouter', model: typeof data.model === 'string' ? data.model : '',
      summaryModel: typeof data.summaryModel === 'string' ? data.summaryModel : '',
      topP: typeof data.topP === 'number' && data.topP >= 0 && data.topP <= 1 ? data.topP : null,
      sessionModels: data.sessionModels && typeof data.sessionModels === 'object' ? data.sessionModels : {},
      sessionSummaryModels: data.sessionSummaryModels && typeof data.sessionSummaryModels === 'object' ? data.sessionSummaryModels : {} };
  } catch { return { ...DEFAULTS }; }
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
