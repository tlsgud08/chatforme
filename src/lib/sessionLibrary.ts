export type LibrarySession = {
  id: string;
  title: string;
  work_id: string;
  is_archived: boolean; // Existing archive flags now represent bookmarks.
  works: { title: string; thumbnail_url: string | null } | null;
  personas: { name: string } | null;
};

export type SessionFolder = { id: string; name: string; parent_id?: string | null; session_folder_items: { session_id: string }[] };
export type LibraryLocation =
  | { kind: 'root' | 'works' | 'personas' | 'bookmarks' }
  | { kind: 'work' | 'persona' | 'custom'; id: string; name: string };

export function matchesSessionSearch(session: LibrarySession, query: string) {
  const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase().trim();
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const text = normalize(`${session.title || session.works?.title || '채팅방'} ${session.personas?.name || ''}`);
  return terms.every(term => text.includes(term));
}

export function groupLibrarySessions(sessions: LibrarySession[], kind: 'works' | 'personas') {
  const groups = new Map<string, { id: string; name: string; count: number }>();
  for (const session of sessions) {
    const name = kind === 'works' ? session.works?.title || '삭제된 작품' : session.personas?.name.trim();
    if (!name) continue;
    // Persona folders intentionally combine personas with the same displayed name.
    const id = kind === 'works' ? session.work_id : name;
    const group = groups.get(id);
    if (group) group.count++;
    else groups.set(id, { id, name, count: 1 });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

export function sessionsInLocation(sessions: LibrarySession[], location: LibraryLocation, folders: SessionFolder[]) {
  if (location.kind === 'bookmarks') return sessions.filter(session => session.is_archived);
  if (location.kind === 'work') return sessions.filter(session => session.work_id === location.id);
  if (location.kind === 'persona') return sessions.filter(session => session.personas?.name.trim() === location.id);
  if (location.kind === 'custom') {
    const ids = new Set(folders.find(folder => folder.id === location.id)?.session_folder_items.map(item => item.session_id));
    return sessions.filter(session => ids.has(session.id));
  }
  return [];
}

export function folderPath(folder: SessionFolder, folders: SessionFolder[]) {
  const path: SessionFolder[] = [];
  const seen = new Set<string>();
  let current: SessionFolder | undefined = folder;
  while (current && !seen.has(current.id)) {
    seen.add(current.id); path.unshift(current);
    current = folders.find(item => item.id === current?.parent_id);
  }
  return path;
}

export type SessionSort = 'latest' | 'turns-desc' | 'turns-asc';
export function sortLibrarySessions(sessions: LibrarySession[], counts: Record<string, number>, order: SessionSort) {
  if (order === 'latest') return sessions;
  return [...sessions].sort((a, b) => {
    const first = counts[a.id], second = counts[b.id];
    if (first === undefined) return second === undefined ? 0 : 1;
    if (second === undefined) return -1;
    return order === 'turns-desc' ? second - first : first - second;
  });
}
