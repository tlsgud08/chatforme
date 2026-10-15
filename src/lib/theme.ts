export type Theme = 'dark' | 'light' | 'custom';
export type ThemeVariant = 'dark' | 'light';
export type ThemePalette = { accent: string; accentText: string; main: string; mainText: string; secondaryText?: string; softenSecondaryText?: boolean; secondaryTextOpacity?: number };
export type SavedTheme = { id: string; owner_id: string; work_id: string | null; name: string; description: string; ai_prompt?: string; work_shared?: boolean; dark_colors: ThemePalette | null; light_colors: ThemePalette | null; is_published: boolean; copied_from_id: string | null; created_at: string; updated_at: string };

const KEY = 'inuchat.theme';
const HEX = /^#[0-9a-f]{6}$/i;
export const DEFAULT_DARK: ThemePalette = { accent:'#6366f1', accentText:'#ffffff', main:'#0f172a', mainText:'#e2e8f0' };
export const DEFAULT_LIGHT: ThemePalette = { accent:'#6366f1', accentText:'#ffffff', main:'#f8fafc', mainText:'#0f172a' };

export function validPalette(value: unknown): value is ThemePalette {
  if (!value || typeof value !== 'object') return false;
  const palette = value as Record<string, unknown>;
  return ['accent','accentText','main','mainText'].every(key => typeof palette[key] === 'string' && HEX.test(palette[key]))
    && (palette.secondaryText === undefined || typeof palette.secondaryText === 'string' && HEX.test(palette.secondaryText))
    && (palette.softenSecondaryText === undefined || typeof palette.softenSecondaryText === 'boolean')
    && (palette.secondaryTextOpacity === undefined || typeof palette.secondaryTextOpacity === 'number' && Number.isInteger(palette.secondaryTextOpacity) && palette.secondaryTextOpacity >= 0 && palette.secondaryTextOpacity <= 100);
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

export type ThemePaletteMode = 'single' | 'dual';
type ThemeColors = Pick<SavedTheme,'dark_colors'|'light_colors'>;
export type ThemePaletteDraft = ThemeColors & { mode: ThemePaletteMode; singleVariant: ThemeVariant };
/** One legacy palette is a single theme. Its slot is only internal rendering metadata. */
export function createPaletteDraft(theme: ThemeColors | null, preferred: ThemeVariant): ThemePaletteDraft {
  const selected = theme ? paletteFor(theme, preferred) : null;
  const singleVariant = selected?.variant ?? preferred;
  return {
    mode: theme && bothVariants(theme) ? 'dual' : 'single', singleVariant,
    dark_colors: theme?.dark_colors ? { ...theme.dark_colors } : singleVariant === 'dark' ? { ...DEFAULT_DARK } : null,
    light_colors: theme?.light_colors ? { ...theme.light_colors } : singleVariant === 'light' ? { ...DEFAULT_LIGHT } : null,
  };
}
/** Keep both editor palettes in memory so changing the mode never discards unsaved colors. */
export function changePaletteMode(draft: ThemePaletteDraft, mode: ThemePaletteMode): ThemePaletteDraft {
  return mode === 'single' ? { ...draft, mode } : {
    ...draft, mode,
    dark_colors: draft.dark_colors ?? { ...DEFAULT_DARK },
    light_colors: draft.light_colors ?? { ...DEFAULT_LIGHT },
  };
}
export function paletteDraftColors(draft: ThemePaletteDraft): ThemeColors {
  return {
    dark_colors: draft.mode === 'dual' || draft.singleVariant === 'dark' ? draft.dark_colors : null,
    light_colors: draft.mode === 'dual' || draft.singleVariant === 'light' ? draft.light_colors : null,
  };
}

export type ThemePreference = {
  prefer_work_theme?: boolean;
  preferred_theme_mode?: Theme | null;
  preferred_theme_id?: string | null;
  preferred_theme_variant?: ThemeVariant | null;
};
export type ThemeWorkDefault = {
  default_theme_id?: string | null;
  default_theme_variant?: ThemeVariant | null;
};
export type ThemeSessionOverride = {
  theme_override?: 'builtin' | 'custom' | null;
  theme_id?: string | null;
  theme_variant?: ThemeVariant | null;
};
/** The global light/dark preference is independent from a fluid chat's visible scene. */
export function preferredThemeVariant(preference:ThemePreference|null,fallback:ThemeVariant):ThemeVariant {
  const mode=preference?.preferred_theme_mode;
  return mode==='light'||mode==='dark'?mode:preference?.preferred_theme_variant??fallback;
}
/** A chat's variant buttons must never deselect the account's custom palette. */
export function themeVariantPreferencePatch(preference:ThemePreference|null,variant:ThemeVariant):Partial<ThemePreference> {
  return preference?.preferred_theme_mode==='custom'
    ? {preferred_theme_variant:variant}
    : {preferred_theme_mode:variant,preferred_theme_variant:variant};
}
/** Strict priority: fixed session > fluid scene > work default > user preference. */
export function resolveThemeSelection(
  preference: ThemePreference | null,
  work: ThemeWorkDefault | null,
  session: ThemeSessionOverride | null,
  fallback: ThemeVariant,
): { themeId: string | null; variant: ThemeVariant } {
  const mode = preference?.preferred_theme_mode;
  const preferredVariant = preferredThemeVariant(preference,fallback);
  if (session?.theme_override === 'builtin') {
    return { themeId: null, variant: session.theme_variant ?? preferredVariant };
  }
  if (session?.theme_override === 'custom') {
    return { themeId: session.theme_id ?? null, variant: session.theme_variant ?? preferredVariant };
  }
  // In fluid mode, keep the last displayed palette/variant (including after
  // switching from a fixed mode). These fields do not select a fixed tab.
  if (session && (session.theme_id || session.theme_variant)) {
    return {themeId:session.theme_id??null,variant:session.theme_variant??preferredVariant};
  }
  if (preference?.prefer_work_theme !== false && work?.default_theme_id) {
    // A chosen global light/dark variant takes priority in fluid mode.
    // Preserve the work author's initial variant only for legacy unset preferences.
    return { themeId: work.default_theme_id, variant: mode == null ? work.default_theme_variant ?? preferredVariant : preferredVariant };
  }
  return { themeId: mode === 'custom' ? preference?.preferred_theme_id ?? null : null, variant: preferredVariant };
}
export function loadTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const saved = window.localStorage.getItem(KEY);
  return saved === 'dark' || saved === 'custom' ? saved : 'light';
}
/** Read the variant actually rendered, including single-variant palette fallback. */
export function appliedThemeVariant(): ThemeVariant {
  if (typeof document === 'undefined') return 'light';
  const root = document.documentElement.dataset;
  return (root.theme === 'custom' ? root.themeVariant : root.theme) === 'dark' ? 'dark' : 'light';
}
export function appliedThemeIsSingle(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'custom'
    && document.documentElement.dataset.themeMode === 'single';
}
/** Describe the palette actually applied, including inherited defaults and fallbacks. */
export function appliedThemeLabel(): string {
  const name = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'custom'
    ? document.documentElement.dataset.themeName || '커스텀 테마'
    : '기본 테마';
  const variant = appliedThemeIsSingle() ? '단일' : appliedThemeVariant() === 'dark' ? '다크' : '라이트';
  return `${name} · ${variant}`;
}
/** Observe application, not the refresh request that starts asynchronous reads. */
export function subscribeAppliedTheme(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-variant', 'data-theme-mode', 'data-theme-name'] });
  return () => observer.disconnect();
}
const vars = ['--color-brand','--color-bg','--color-surface','--color-surface2','--page-bg','--page-text','--custom-accent-text','--secondary-text','--secondary-text-soft','--secondary-text-muted','--chat-secondary-color','--chat-secondary-opacity','--secondary-extra-opacity'];
const rgb = (hex: string) => [1,3,5].map(i => parseInt(hex.slice(i,i+2), 16));
const rgbValue = (hex: string) => rgb(hex).join(' ');
const mix = (a: string, b: string, ratio: number) => {
  const first=rgb(a), second=rgb(b);
  return first.map((channel,index)=>Math.round(channel*(1-ratio)+second[index]*ratio)).join(' ');
};
let transitionTimer: ReturnType<typeof setTimeout> | undefined;
function beginThemeTransition() {
  const root=document.documentElement;
  if(!root.classList)return;
  root.classList.add('theme-transition');
  if(transitionTimer)clearTimeout(transitionTimer);
  transitionTimer=setTimeout(()=>root.classList.remove('theme-transition'),450);
}
export function applyTheme(theme: ThemeVariant) {
  const root=document.documentElement;
  if(root.dataset.theme!==theme)beginThemeTransition();
  vars.forEach(name => root.style.removeProperty(name));
  root.dataset.theme=theme;
  delete root.dataset.themeVariant;
  delete root.dataset.themeMode;
  delete root.dataset.themeName;
  root.style.colorScheme=theme;
  window.localStorage.setItem(KEY,theme);
}
/** Missing opacity uses the default 65%; old palettes still inherit their chat foreground. */
export function secondaryTextStyles(palette: ThemePalette) {
  const color=palette.secondaryText??palette.mainText;
  const soften=palette.softenSecondaryText!==false;
  const opacity=palette.secondaryTextOpacity??65;
  return {
    color,
    soft:soften?`color-mix(in srgb, ${color} ${opacity}%, ${palette.main})`:color,
    muted:soften?`color-mix(in srgb, ${color} ${opacity}%, ${palette.main})`:color,
    chatColor:palette.secondaryText??'inherit',
    chatOpacity:soften?opacity/100:1,
    // Links already use the faded secondary color; avoid applying opacity twice.
    extraOpacity:1,
  };
}
export function applyCustomTheme(palette: ThemePalette, variant: ThemeVariant, mode: ThemePaletteMode = 'dual', name?: string) {
  const root=document.documentElement;
  const secondary=secondaryTextStyles(palette);
  if(root.dataset.theme!=='custom'||root.style.getPropertyValue('--page-bg')!==palette.main||root.style.getPropertyValue('--color-brand')!==rgbValue(palette.accent)||root.style.getPropertyValue('--page-text')!==palette.mainText||root.style.getPropertyValue('--custom-accent-text')!==palette.accentText||root.style.getPropertyValue('--secondary-text')!==secondary.color||root.style.getPropertyValue('--chat-secondary-opacity')!==String(secondary.chatOpacity))beginThemeTransition();
  root.dataset.theme='custom';
  root.dataset.themeVariant=variant;
  root.dataset.themeMode=mode;
  if(name)root.dataset.themeName=name;
  else delete root.dataset.themeName;
  root.style.colorScheme=variant;
  root.style.setProperty('--color-brand',rgbValue(palette.accent));
  root.style.setProperty('--color-bg',rgbValue(palette.main));
  root.style.setProperty('--color-surface',mix(palette.main,palette.mainText,0.075));
  root.style.setProperty('--color-surface2',mix(palette.main,palette.mainText,0.16));
  root.style.setProperty('--page-bg',palette.main);
  root.style.setProperty('--page-text',palette.mainText);
  root.style.setProperty('--custom-accent-text',palette.accentText);
  root.style.setProperty('--secondary-text',secondary.color);
  root.style.setProperty('--secondary-text-soft',secondary.soft);
  root.style.setProperty('--secondary-text-muted',secondary.muted);
  root.style.setProperty('--chat-secondary-color',secondary.chatColor);
  root.style.setProperty('--chat-secondary-opacity',String(secondary.chatOpacity));
  root.style.setProperty('--secondary-extra-opacity',String(secondary.extraOpacity));
}
export function saveTheme(theme: ThemeVariant) { applyTheme(theme); }
export function requestThemeRefresh() { window.dispatchEvent(new Event('inuchat:theme-changed')); }
