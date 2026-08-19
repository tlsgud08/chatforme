// 비회원 모드: 세션과 메시지를 localStorage 에만 저장
import type { Message, Session, Work } from '@/types/db';

const SESSIONS_KEY = 'inuchat.guest.sessions';
const LEGACY_SESSIONS_KEY = 'nekochat.guest.sessions';

export interface GuestMessage extends Pick<Message, 'id' | 'role' | 'content' | 'turn_index' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'cost' | 'is_hidden' | 'created_at'> {
  session_id: string;
}

export interface GuestSession extends Pick<Session, 'id' | 'work_id' | 'title' | 'user_note' | 'output_tokens_override' | 'start_config_id' | 'total_input_tokens' | 'total_output_tokens' | 'total_cost' | 'created_at' | 'updated_at'> {
  messages: GuestMessage[];
}

function load(): GuestSession[] {
  try {
    const stored = localStorage.getItem(SESSIONS_KEY) ?? localStorage.getItem(LEGACY_SESSIONS_KEY);
    if (stored && localStorage.getItem(SESSIONS_KEY) === null) localStorage.setItem(SESSIONS_KEY, stored);
    return JSON.parse(stored ?? '[]') as GuestSession[];
  } catch {
    return [];
  }
}

function save(sessions: GuestSession[]): void {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

export function guestGetSessions(): GuestSession[] {
  return load().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function guestGetSession(id: string): GuestSession | null {
  const session = load().find((s) => s.id === id);
  if (!session) return null;
  return {
    ...session,
    messages: session.messages.map((message) => ({
      ...message,
      cache_read_tokens: message.cache_read_tokens ?? null,
      cache_write_tokens: message.cache_write_tokens ?? null,
    })),
  };
}

export function guestCreateSession(work: Pick<Work, 'id' | 'title'>): GuestSession {
  const now = new Date().toISOString();
  const session: GuestSession = {
    id: crypto.randomUUID(),
    work_id: work.id,
    title: work.title,
    user_note: '',
    output_tokens_override: null,
    start_config_id: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost: 0,
    created_at: now,
    updated_at: now,
    messages: [],
  };
  const sessions = load();
  sessions.unshift(session);
  save(sessions);
  return session;
}

export function guestAddMessage(sessionId: string, msg: Omit<GuestMessage, 'session_id'>): void {
  const sessions = load();
  const s = sessions.find((s) => s.id === sessionId);
  if (!s) return;
  s.messages.push({ ...msg, session_id: sessionId });
  s.updated_at = new Date().toISOString();
  save(sessions);
}

export function guestUpdateSession(sessionId: string, patch: Partial<GuestSession>): void {
  const sessions = load();
  const idx = sessions.findIndex((s) => s.id === sessionId);
  if (idx === -1) return;
  sessions[idx] = { ...sessions[idx], ...patch, updated_at: new Date().toISOString() };
  save(sessions);
}

export function guestDeleteSession(sessionId: string): void {
  save(load().filter((session) => session.id !== sessionId));
}

export function guestUpdateMessage(sessionId: string, messageId: string, content: string): void {
  const sessions = load();
  const s = sessions.find((s) => s.id === sessionId);
  if (!s) return;
  const msg = s.messages.find((m) => m.id === messageId);
  if (!msg) return;
  msg.content = content;
  s.updated_at = new Date().toISOString();
  save(sessions);
}

export function guestDeleteMessage(sessionId: string, messageId: string): void {
  const sessions = load();
  const s = sessions.find((s) => s.id === sessionId);
  if (!s) return;
  s.messages = s.messages.filter((m) => m.id !== messageId);
  s.updated_at = new Date().toISOString();
  save(sessions);
}
