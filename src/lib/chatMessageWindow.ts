import type { Message } from '@/types/db';

/** Release only older display rows; keep every variant and hidden row in retained turns. */
export function latestChatMessageWindow(messages: Message[]): Message[] {
  const turns = [...new Set(messages.filter(message => message.role === 'user' && !message.is_hidden
    && message.is_active_variant !== false).map(message => message.turn_index))].sort((a, b) => a - b);
  if (turns.length <= 10) return messages;
  const cutoff = turns[turns.length - 10];
  return messages.filter(message => message.turn_index >= cutoff);
}

/** Show navigation after the whole latest turn has moved below the viewport. */
export function hasPassedLatestChatTurn(element: HTMLElement): boolean {
  const starts = element.querySelectorAll<HTMLElement>('[data-chat-turn-start]');
  const latest = starts[starts.length - 1];
  return !!latest && element.scrollHeight - element.clientHeight - element.scrollTop > 2
    && latest.getBoundingClientRect().top >= element.getBoundingClientRect().bottom - 2;
}
