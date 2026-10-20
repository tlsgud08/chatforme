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

const APP_WIDTH_KEY = 'inuchat.interface-app-width-450.v1';
const CHAT_WIDTH_KEY = 'inuchat.interface-chat-width-450.v1';
const WIDTH_CHANGE_EVENT = 'inuchat:interface-width-changed';

function loadWidthLimit(key: string, fallback: boolean): boolean {
  try {
    const saved = window.localStorage.getItem(key);
    return saved === 'true' ? true : saved === 'false' ? false : fallback;
  } catch {
    return fallback;
  }
}

function saveWidthLimit(key: string, enabled: boolean): boolean {
  try {
    window.localStorage.setItem(key, String(enabled));
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(WIDTH_CHANGE_EVENT));
  return true;
}

export function loadAppWidthLimited(): boolean {
  return loadWidthLimit(APP_WIDTH_KEY, false);
}

export function saveAppWidthLimited(enabled: boolean): boolean {
  return saveWidthLimit(APP_WIDTH_KEY, enabled);
}

export function loadChatWidthLimited(): boolean {
  return loadWidthLimit(CHAT_WIDTH_KEY, true);
}

export function saveChatWidthLimited(enabled: boolean): boolean {
  return saveWidthLimit(CHAT_WIDTH_KEY, enabled);
}

export function subscribeInterfaceWidth(listener: () => void): () => void {
  const storageChanged = (event: StorageEvent) => {
    if (event.key === APP_WIDTH_KEY || event.key === CHAT_WIDTH_KEY || event.key === null) listener();
  };
  window.addEventListener(WIDTH_CHANGE_EVENT, listener);
  window.addEventListener('storage', storageChanged);
  return () => {
    window.removeEventListener(WIDTH_CHANGE_EVENT, listener);
    window.removeEventListener('storage', storageChanged);
  };
}
