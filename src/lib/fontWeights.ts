export type FontWeights = { normal: number; bold: number };
export const DEFAULT_FONT_WEIGHTS: FontWeights = { normal: 400, bold: 700 };
export function normalizeFontWeights(value: unknown): FontWeights {
  const input = value && typeof value === 'object' ? value as Partial<FontWeights> : {};
  const parse = (n: unknown, fallback: number) => typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 1000 ? Math.round(n) : fallback;
  return { normal: parse(input.normal, 400), bold: parse(input.bold, 700) };
}
export function applyFontWeights(value: unknown) {
  const weights = normalizeFontWeights(value);
  document.documentElement.style.setProperty('--chat-font-weight', String(weights.normal));
  document.documentElement.style.setProperty('--chat-bold-weight', String(weights.bold));
}
