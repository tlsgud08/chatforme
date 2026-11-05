import { useSyncExternalStore } from 'react';

const key = 'inuchat.workCreditsEnabled';
const changed = 'inuchat:work-credits-changed';
export function loadWorkCredits(): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
export function saveWorkCredits(enabled: boolean) {
  try { localStorage.setItem(key, enabled ? '1' : '0'); } catch { return; }
  window.dispatchEvent(new Event(changed));
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) listener(); };
  window.addEventListener(changed, listener);
  window.addEventListener('storage', storage);
  window.addEventListener('focus', listener);
  return () => { window.removeEventListener(changed, listener); window.removeEventListener('storage', storage); window.removeEventListener('focus', listener); };
}
export function useWorkCredits() { return useSyncExternalStore(subscribe, loadWorkCredits, loadWorkCredits); }
