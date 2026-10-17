import type { Message } from '@/types/db';
import { stripThemeDirectives } from './themeDirectives';

/** Receives the complete history in logical turn order, including the opening scene. */
export function formatConversationText(messages: readonly Message[]): string {
  const blocks: string[] = [];
  let turn = 0;
  for (const message of messages) {
    if (message.is_hidden || message.is_active_variant === false) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    let content = stripThemeDirectives(message.content);
    if (message.generation_status !== 'complete') content = content.replace(/\{\{theme::[^{}]*$/, '');
    content = content.replace(/^[\r\n]+|[\r\n]+$/g, '');
    if (message.role === 'user') {
      turn += 1;
      const input = [message.command_name ? `/${message.command_name}` : '', content].filter(Boolean).join('\n');
      blocks.push(`${turn}턴: ${input}`);
    } else if (content.trim()) {
      blocks.push(content);
    }
  }
  return blocks.join('\n\n');
}

export function conversationFilename(title: string, now = new Date()): string {
  const name = title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim().replace(/[. ]+$/, '').slice(0, 100) || '대화';
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${name}_${date}_${time}.txt`;
}

export function downloadConversationText(content: string, filename: string): void {
  // A BOM lets Windows text editors recognize Korean as UTF-8 as well.
  const blob = new Blob(['\uFEFF', content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    // Keep the URL alive until the browser has started the download (including Safari).
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
