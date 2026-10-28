import type { GenerateOptions, SystemParts } from './llm/types';

/** Reserved display metadata; stored messages are preserved. */
export function stripSyncDateTags(content: string, streaming = false): string {
  let visible = content.replace(/\{\{sync_date::([^{}\r\n]{0,200})\}\}/g, '');
  if (streaming) {
    const start = visible.lastIndexOf('{{');
    if (start >= 0) {
      const suffix = visible.slice(start);
      if ('{{sync_date::'.startsWith(suffix) || (suffix.startsWith('{{sync_date::') && !suffix.includes('}}'))) visible = visible.slice(0, start);
    }
  }
  return visible;
}

/** Disconnected requests must not inherit sync tags from any context section. */
export function withoutSyncDateTags<T extends Pick<GenerateOptions, 'systemParts' | 'messages'>>(request: T): T {
  const clean = (text: string) => text.replace(/\{\{sync_date::[^{}]*(?:\}\}|$)/g, '');
  return { ...request,
    systemParts: Object.fromEntries(Object.entries(request.systemParts).map(([key, value]) => [key, typeof value === 'string' ? clean(value) : value])) as unknown as SystemParts,
    messages: request.messages.map(message => ({ ...message, content: clean(message.content) })),
  };
}
