import type { Command, Message } from '@/types/db';

export const CONTINUE_MESSAGE = '*이어서 계속 진행*';

/** Decide from the fresh, complete dialogue, never from a paginated screen. */
export function resolveChatSubmission(input: string, command: Command | null, messages: Message[]) {
  const text = input.trim();
  if (text || command) return { text, reusedUser: null };
  const latest = [...messages].reverse().find(message => !message.is_hidden && message.is_active_variant !== false);
  return latest?.role === 'user'
    ? { text: latest.content, reusedUser: latest }
    : { text: CONTINUE_MESSAGE, reusedUser: null };
}
