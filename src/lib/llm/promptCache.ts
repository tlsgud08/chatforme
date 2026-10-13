import type { Message } from '@/types/db';
import type { GenerateOptions } from './types';

export const supportsManualPromptCache = (model: string) => model.startsWith('google/gemini-');

export type CacheMessage = Pick<Message, 'id' | 'role' | 'is_hidden' | 'is_active_variant' | 'generation_status'>;

/** Use the same visible-user counting as ChatPage's summary cutoff and turn labels. */
export function cacheTurnChoices(messages: CacheMessage[], summaryThroughTurn: number) {
  let turn = 0;
  const choices: { id: string; turn: number }[] = [];
  for (const message of messages) {
    if (message.is_active_variant === false) continue;
    if (message.role === 'user' && !message.is_hidden) turn += 1;
    if (message.role === 'assistant' && !message.is_hidden &&
      message.generation_status !== 'streaming' && message.generation_status !== 'interrupted' &&
      turn > summaryThroughTurn) choices.push({ id: message.id, turn });
  }
  return choices;
}

/** Resolve against the actual outgoing history, after summary and reroll filtering. */
export function resolvePromptCache(
  enabled: boolean, model: string, targetId: string | null, history: CacheMessage[],
): { systemOnly: boolean; messageId?: string; unavailable: boolean } {
  if (!enabled || !supportsManualPromptCache(model)) return { systemOnly: false, unavailable: false };
  if (targetId === null) return { systemOnly: true, unavailable: false };
  const target = history.find((m) => m.id === targetId && m.role === 'assistant' && !m.is_hidden &&
    m.is_active_variant !== false && m.generation_status !== 'streaming' && m.generation_status !== 'interrupted');
  return target
    ? { systemOnly: false, messageId: target.id, unavailable: false }
    : { systemOnly: false, unavailable: true };
}

type WireMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | { type: 'text'; text: string; cache_control: { type: 'ephemeral' } }[];
};
const markedContent = (text: string): WireMessage['content'] => [
  { type: 'text', text, cache_control: { type: 'ephemeral' } },
];

export function buildOpenRouterMessages(opts: Pick<GenerateOptions, 'model' | 'systemParts' | 'messages' | 'cacheSystemOnly'>): WireMessage[] {
  const system = [opts.systemParts.core, opts.systemParts.persona, opts.systemParts.userNote,
    opts.systemParts.summary, opts.systemParts.storyNotes].filter(Boolean).join('\n\n');
  const supported = supportsManualPromptCache(opts.model);
  const breakpoint = supported ? opts.messages.findIndex((m) => m.cacheBreakpoint) : -1;
  const explicit = supported && (!!opts.cacheSystemOnly || breakpoint >= 0);
  // A pinned final history answer is still history, never the current user input.
  const lastIsBoundary = breakpoint >= 0 && breakpoint === opts.messages.length - 1;
  const history = lastIsBoundary ? opts.messages : opts.messages.slice(0, -1);
  const current = lastIsBoundary ? undefined : opts.messages.at(-1);
  const result: WireMessage[] = system
    ? [{ role: 'system', content: supported && opts.cacheSystemOnly ? markedContent(system) : system }]
    : [];
  history.forEach((m, index) => result.push({ role: m.role,
    content: explicit && !opts.cacheSystemOnly && index === breakpoint ? markedContent(m.content) : m.content }));
  // Gemini's cached systemInstruction is immutable. In explicit mode keep dynamic
  // keywords outside it by attaching them to the current user input instead.
  if (explicit && opts.systemParts.keywords) {
    result.push({ role: 'user', content: [opts.systemParts.keywords, current?.role === 'user' ? current.content : ''].filter(Boolean).join('\n\n') });
    if (current && current.role !== 'user') result.push({ role: current.role, content: current.content });
  } else {
    if (opts.systemParts.keywords) result.push({ role: 'system', content: opts.systemParts.keywords });
    if (current) result.push({ role: current.role, content: current.content });
  }
  return result;
}
