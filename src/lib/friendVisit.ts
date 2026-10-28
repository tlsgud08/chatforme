// A document keeps its visit through socket reconnects and bfcache restores.
// Only a browser reload resumes the previous document's visit from tab storage.
let current: { userId: string; id: string } | undefined;
let initialized = false;
const storageKey = (userId: string) => `inuchat:friend-visit:${userId}`;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function friendVisitKey(userId: string): string {
  if (current?.userId === userId) return current.id;
  let saved: string | null = null;
  try {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!initialized && navigation?.type === 'reload') saved = sessionStorage.getItem(storageKey(userId));
  } catch { /* A fresh in-memory visit also works when tab storage is blocked. */ }
  initialized = true;
  const id = saved && uuid.test(saved) ? saved : crypto.randomUUID();
  current = { userId, id };
  try { sessionStorage.setItem(storageKey(userId), id); } catch { /* Keep this document's visit. */ }
  return id;
}

export function endFriendVisit() {
  if (current) { try { sessionStorage.removeItem(storageKey(current.userId)); } catch { /* Storage can be unavailable. */ } }
  current = undefined;
  initialized = true;
}
