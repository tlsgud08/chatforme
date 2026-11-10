import { useSyncExternalStore } from 'react';
import { useAuth } from './useAuth';
import { loadLocalPreferences, localModelFor, subscribeLocalPreferences, summaryProviderFor } from '@/lib/localPreferences';

export function useLocalProvider(sessionId = '', summary = false) {
  const { user } = useAuth();
  const provider = useSyncExternalStore(subscribeLocalPreferences, () => summary ? summaryProviderFor(user?.id, sessionId) : loadLocalPreferences(user?.id).provider, () => 'openrouter' as const);
  const model = useSyncExternalStore(subscribeLocalPreferences, () => localModelFor(user?.id, sessionId, summary), () => '');
  return { provider, model, userId: user?.id };
}
