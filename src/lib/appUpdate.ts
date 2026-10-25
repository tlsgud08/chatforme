import { registerSW } from 'virtual:pwa-register';

let waiting = false;
let started = false;
const listeners = new Set<() => void>();
export const hasAppUpdate = () => waiting;

export function subscribeAppUpdate(listener: () => void) {
  listeners.add(listener);
  if (!started) {
    started = true;
    let registration: ServiceWorkerRegistration | undefined;
    let lastCheck = 0;
    const ready = () => {
      waiting = true;
      listeners.forEach(notify => notify());
    };
    registerSW({
      immediate: false,
      onNeedRefresh: ready,
      onRegisteredSW(_url, value) {
        registration = value;
        if (value?.waiting) ready();
      },
    });
    const check = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastCheck < 60_000 || !registration) return;
      lastCheck = Date.now();
      void registration.update().catch(() => {});
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
  }
  return () => { listeners.delete(listener); };
}
