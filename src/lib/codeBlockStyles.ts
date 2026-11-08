/** Shared order for theme editors and fixed chat-room choices. */
export const CODE_BLOCK_STYLES = [
  { value: 'basic', label: '기본' },
  { value: 'legacy', label: '레거시' },
  { value: 'neon', label: '네온 단말' },
  { value: 'corporate', label: '기업 기밀' },
  { value: 'hanji', label: '한지 기록' },
  { value: 'scroll', label: '와시 두루마리' },
  { value: 'grimoire', label: '판타지 서책' },
  { value: 'noir', label: '필름 느와르' },
  { value: 'notebook', label: '파스텔 노트' },
] as const;

export type CodeBlockStyle = typeof CODE_BLOCK_STYLES[number]['value'];
export function normalizeCodeBlockStyle(value: unknown): CodeBlockStyle {
  return CODE_BLOCK_STYLES.some(style => style.value === value) ? value as CodeBlockStyle : 'basic';
}

export type CodeBlockPreference = { use_legacy_status?: boolean };
export type CodeBlockSession = { use_theme_code_block?: boolean; code_block_style?: string | null };
export type CodeBlockTheme = { code_block_style?: string | null };

/** Account accessibility preference > fixed room choice > visible theme > basic. */
export function resolveCodeBlockStyle(
  preference: CodeBlockPreference | null,
  session: CodeBlockSession | null,
  theme: CodeBlockTheme | null,
): CodeBlockStyle {
  if (preference?.use_legacy_status) return 'legacy';
  if (session?.use_theme_code_block === false) return normalizeCodeBlockStyle(session.code_block_style);
  return normalizeCodeBlockStyle(theme?.code_block_style);
}

const listeners = new Set<() => void>();
export function appliedCodeBlockStyle(): CodeBlockStyle {
  return typeof document === 'undefined' ? 'basic' : normalizeCodeBlockStyle(document.documentElement.dataset.codeBlockStyle);
}
export function subscribeCodeBlockStyle(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Reuse ThemeManager's existing reads; do not add a request per message/block. */
export function applyCodeBlockStyle(style: CodeBlockStyle): void {
  if (appliedCodeBlockStyle() === style && document.documentElement.dataset.codeBlockStyle === style) return;
  document.documentElement.dataset.codeBlockStyle = style;
  listeners.forEach(listener => listener());
}
