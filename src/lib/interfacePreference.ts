export type InterfaceDesign = 'modern' | 'legacy';

const KEY = 'inuchat.interface-design.v1';
const CHANGE_EVENT = 'inuchat:interface-design-changed';

/** Layout is a device preference, independent of account and scene colors. */
export function loadInterfaceDesign(): InterfaceDesign {
  try {
    return window.localStorage.getItem(KEY) === 'legacy' ? 'legacy' : 'modern';
  } catch {
    return 'modern';
  }
}

export function saveInterfaceDesign(design: InterfaceDesign): boolean {
  try {
    window.localStorage.setItem(KEY, design);
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return true;
}

export function subscribeInterfaceDesign(listener: () => void): () => void {
  const storageChanged = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', storageChanged);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', storageChanged);
  };
}
