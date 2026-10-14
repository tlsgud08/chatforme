export type Theme = 'dark' | 'light' | 'custom';
export type ThemeVariant = 'dark' | 'light';
export type ThemePalette = { accent: string; accentText: string; main: string; mainText: string };
export type SavedTheme = { id: string; owner_id: string; work_id: string | null; name: string; description: string; dark_colors: ThemePalette | null; light_colors: ThemePalette | null; is_published: boolean; copied_from_id: string | null; created_at: string; updated_at: string };

const KEY = 'inuchat.theme';
const HEX = /^#[0-9a-f]{6}$/i;
export const DEFAULT_DARK: ThemePalette = { accent:'#6366f1', accentText:'#ffffff', main:'#0f172a', mainText:'#e2e8f0' };
export const DEFAULT_LIGHT: ThemePalette = { accent:'#6366f1', accentText:'#ffffff', main:'#f8fafc', mainText:'#0f172a' };

export function validPalette(value: unknown): value is ThemePalette {
  if (!value || typeof value !== 'object') return false;
  const palette = value as Record<string, unknown>;
  return ['accent','accentText','main','mainText'].every(key => typeof palette[key] === 'string' && HEX.test(palette[key]));
}
export function paletteFor(theme: Pick<SavedTheme,'dark_colors'|'light_colors'>, choice: ThemeVariant): {palette: ThemePalette; variant: ThemeVariant} | null {
  if (choice === 'dark' && validPalette(theme.dark_colors)) return { palette:theme.dark_colors, variant:'dark' };
  if (choice === 'light' && validPalette(theme.light_colors)) return { palette:theme.light_colors, variant:'light' };
  if (validPalette(theme.dark_colors)) return { palette:theme.dark_colors, variant:'dark' };
  if (validPalette(theme.light_colors)) return { palette:theme.light_colors, variant:'light' };
  return null;
}
export function bothVariants(theme: Pick<SavedTheme,'dark_colors'|'light_colors'>): boolean {
  return validPalette(theme.dark_colors) && validPalette(theme.light_colors);
}
export function loadTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const saved = window.localStorage.getItem(KEY);
  return saved === 'dark' || saved === 'custom' ? saved : 'light';
}
const vars = ['--color-brand','--color-bg','--color-surface','--color-surface2','--page-bg','--page-text','--custom-accent-text'];
const rgb = (hex: string) => [1,3,5].map(i => parseInt(hex.slice(i,i+2), 16));
const rgbValue = (hex: string) => rgb(hex).join(' ');
const mix = (a: string, b: string, ratio: number) => {
  const first=rgb(a), second=rgb(b);
  return first.map((channel,index)=>Math.round(channel*(1-ratio)+second[index]*ratio)).join(' ');
};
export function applyTheme(theme: ThemeVariant) {
  const root=document.documentElement;
  vars.forEach(name => root.style.removeProperty(name));
  root.dataset.theme=theme;
  delete root.dataset.themeVariant;
  root.style.colorScheme=theme;
  window.localStorage.setItem(KEY,theme);
}
export function applyCustomTheme(palette: ThemePalette, variant: ThemeVariant) {
  const root=document.documentElement;
  root.dataset.theme='custom';
  root.dataset.themeVariant=variant;
  root.style.colorScheme=variant;
  root.style.setProperty('--color-brand',rgbValue(palette.accent));
  root.style.setProperty('--color-bg',rgbValue(palette.main));
  root.style.setProperty('--color-surface',mix(palette.main,palette.mainText,0.075));
  root.style.setProperty('--color-surface2',mix(palette.main,palette.mainText,0.16));
  root.style.setProperty('--page-bg',palette.main);
  root.style.setProperty('--page-text',palette.mainText);
  root.style.setProperty('--custom-accent-text',palette.accentText);
}
export function saveTheme(theme: ThemeVariant) { applyTheme(theme); }
export function requestThemeRefresh() { window.dispatchEvent(new Event('inuchat:theme-changed')); }
