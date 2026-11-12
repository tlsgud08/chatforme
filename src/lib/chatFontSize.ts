/** null means use each message/status style's original size. */
export function normalizeChatFontSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 96 ? value : null;
}
export function applyChatFontSize(value: unknown): void {
  const size = normalizeChatFontSize(value);
  const root = document.documentElement;
  if (size === null) {
    root.style.removeProperty('--chat-font-size');
    delete root.dataset.chatFontSize;
  } else {
    root.style.setProperty('--chat-font-size', `${size}px`);
    root.dataset.chatFontSize = 'custom';
  }
}
