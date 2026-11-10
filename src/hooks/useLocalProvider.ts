import { useSyncExternalStore } from 'react';
import { useAuth } from './useAuth';
import { loadLocalPreferences, localModelFor, subscribeLocalPreferences } from '@/lib/localPreferences';

export function useLocalProvider(sessionId = '', summary = false) {
  const { user } = useAuth();
  const provider = useSyncExternalStore(subscribeLocalPreferences, () => loadLocalPreferences(user?.id).provider, () => 'openrouter' as const);
  const model = useSyncExternalStore(subscribeLocalPreferences, () => localModelFor(user?.id, sessionId, summary), () => '');
  return { provider, model, userId: user?.id };
}
