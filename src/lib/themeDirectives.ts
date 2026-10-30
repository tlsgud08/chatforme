import { bothVariants, type SavedTheme, type ThemeSessionOverride, type ThemeVariant } from './theme';

export type ThemePeriod='day'|'night';
export const DAY_THEME_CONDITION='해가 떠 있는 낮에 사용하세요.';
export const NIGHT_THEME_CONDITION='해가 완전히 진 밤애 사용하세요.';
export function dayNightModeEnabled(session:ThemeSessionOverride|null,preference:ThemeVariant):boolean {
  return session?.theme_override==null&&session?.theme_day_night_enabled===true&&preference==='light';
}
export function dayNightThemeEligible(theme:SavedTheme):boolean {
  return !!theme.work_id&&bothVariants(theme)&&theme.use_day_night_variants!==false;
}
/** The legacy column stores an availability condition, not support for two palettes. */
export function automaticThemeAvailable(theme:SavedTheme,dayNight:boolean):boolean {
  return theme.day_night_enabled!==true||dayNight;
}
export function dayNightDisplayVariant(theme:SavedTheme,session:ThemeSessionOverride|null,preference:ThemeVariant,fallback:ThemeVariant):ThemeVariant {
  // Opted-out work scenes always follow the account preference in fluid mode,
  // including legacy rooms retaining an obsolete night/manual variant.
  if(session?.theme_override==null&&theme.work_id&&bothVariants(theme)&&theme.use_day_night_variants===false)return preference;
  if(dayNightModeEnabled(session,preference)&&dayNightThemeEligible(theme)){
    return session?.theme_period==='night'?'dark':'light';
  }
  return fallback;
}
export function themeDirectiveName(theme:SavedTheme,period:ThemePeriod|null|undefined,enabled:boolean):string {
  return enabled&&dayNightThemeEligible(theme)?`${theme.name}:${period==='night'?'밤':'낮'}`:theme.name;
}
/** Transform request copies only. Stored messages, summaries and cache markers remain intact. */
export function normalizeThemePeriods(content:string,enabledNames:readonly string[]=[]):string {
  const enabled=new Set(enabledNames);
  return content.replace(/\{\{theme::([^{}]+):(낮|밤)\}\}/g,(tag,name:string)=>enabled.has(name.trim())?tag:`{{theme::${name}}}`);
}

export const DEFAULT_THEME_PROMPT = `장면의 장소, 시간, 분위기와 테마별 적용 조건을 판단하세요.
응답의 어느 위치에든 {{theme::테마이름}}을 출력할 수 있습니다. 여러 개면 마지막 유효 태그를 적용합니다. 변경할 필요가 없으면 {{theme::keep}}을 출력하세요.
사용 가능한 목록의 이름만 정확히 사용하고, 본문에서 테마 변경을 설명하지 마세요.`;

export function stripThemeDirectives(content: string, streaming = false): string {
  const clean = content.replace(/\{\{theme::[^{}]*\}\}/g, '');
  // Buffer a partial control suffix so streamed tokens never flash on screen.
  if (!streaming) return clean;
  const start=clean.lastIndexOf('{{');
  if(start>=0){
    const tail=clean.slice(start);
    if('{{theme::'.startsWith(tail)||tail.startsWith('{{theme::')&&!tail.includes('}}'))return clean.slice(0,start);
  }
  return clean.endsWith('{')?clean.slice(0,-1):clean;
}
export function finalThemeDirective(content: string): string | null {
  const tags = Array.from(content.matchAll(/\{\{theme::([^{}]+)\}\}/g));
  return tags.at(-1)?.[1].trim() || null;
}

/** Validate backwards: an unknown/unauthorized suffix cannot hide an earlier valid directive. */
export function finalValidThemeDirective(content:string,themes:SavedTheme[],enabled=false,qualified=false):string|null {
  const tags=Array.from(content.matchAll(/\{\{theme::([^{}]+)\}\}/g));
  for(let i=tags.length-1;i>=0;i--){const name=tags[i][1].trim();if(name==='keep'||resolveThemeDirectiveChoice(name,themes,enabled,qualified))return name;}
  return null;
}
export function availableWorkThemes(themes: SavedTheme[], workId: string | readonly string[], userId: string): SavedTheme[] {
  const ids = new Set(typeof workId === 'string' ? [workId] : workId);
  return themes.filter(t => t.work_id !== null && ids.has(t.work_id) && (t.work_shared !== false || t.owner_id === userId));
}
export type ThemeCatalogScope = { workNames: Readonly<Record<string, string>> };
export function themeDirectiveBaseName(theme: SavedTheme, qualified = false): string {
  return qualified ? `id:${theme.id}` : theme.name;
}
export function dayNightCatalogNames(themes: SavedTheme[], qualified = false): string[] {
  return [...new Set(themes.filter(dayNightThemeEligible).flatMap(theme =>
    qualified ? [theme.name, themeDirectiveBaseName(theme, true)] : [theme.name]))];
}
function themeChoices(themes:SavedTheme[],enabled:boolean,qualified=false){
  const choices=themes.filter(theme=>automaticThemeAvailable(theme,enabled)).sort((a,b)=>a.id.localeCompare(b.id)).flatMap(theme=>
    enabled&&dayNightThemeEligible(theme)
      ?(['day','night']as const).map(period=>({theme,period,name:qualified?`${themeDirectiveBaseName(theme,true)}:${period==='night'?'밤':'낮'}`:themeDirectiveName(theme,period,true)}))
      :[{theme,period:null as ThemePeriod|null,name:themeDirectiveBaseName(theme,qualified)}]);
  // Legacy suffix names can collide with generated choices. Never choose arbitrarily.
  const counts=new Map<string,number>();
  for(const choice of choices)counts.set(choice.name.trim(),(counts.get(choice.name.trim())??0)+1);
  return choices.filter(choice=>counts.get(choice.name.trim())===1);
}
/** One scene's day/night palettes do not make it multiple work themes. */
export function automaticThemeEnabled(session:ThemeSessionOverride|null,themes:SavedTheme[],dayNight=false,qualified=false):boolean {
  return session?.theme_override==null&&new Set(themeChoices(themes,dayNight,qualified).map(choice=>choice.theme.id)).size>1;
}
export function themeCatalogPrompt(themes: SavedTheme[],enabled=false,scope?:ThemeCatalogScope): string {
  // Keep the original single-work catalog byte-for-byte when scope is omitted.
  return themeChoices(themes,enabled,!!scope).map(({theme,period,name})=>
    `- 이름: ${name}${scope?`\n  테마명: ${JSON.stringify(theme.name)}\n  작품: ${JSON.stringify(scope.workNames[theme.work_id??'']??'작품')}`:''}\n  적용 조건: ${theme.ai_prompt?.trim() || '별도 조건 없음'}${period?'\n  '+(period==='day'?DAY_THEME_CONDITION:NIGHT_THEME_CONDITION):''}`).join('\n\n');
}
export function resolveThemeDirectiveChoice(name:string|null,themes:SavedTheme[],enabled=false,qualified=false):{theme:SavedTheme;period:ThemePeriod|null}|null {
  if(!name||name==='keep')return null;
  const choices=themeChoices(themes,enabled,qualified);
  const matches=choices.filter(choice=>choice.name.trim()===name);
  if(matches.length===1)return {theme:matches[0].theme,period:matches[0].period};
  // With the feature OFF, old suffixed responses still select the original theme.
  if(!enabled&&/:(낮|밤)$/.test(name))return resolveThemeDirectiveChoice(name.replace(/:(낮|밤)$/,''),themes,false,qualified);
  // Accept legacy names only when unambiguous. An obsolete ID must never be
  // reinterpreted as a literal name belonging to an unrelated theme.
  if(qualified&&!name.startsWith('id:'))return resolveThemeDirectiveChoice(name,themes,enabled,false);
  return null;
}
export function resolveDirectiveTheme(name: string | null, themes: SavedTheme[]): SavedTheme | null {
  return resolveThemeDirectiveChoice(name,themes)?.theme??null;
}

export type ThemeObservation = { sessionId: string; fingerprint: string };
export function observeThemeDirective(previous: ThemeObservation | null, sessionId: string, latest: {id:string;content:string} | null) {
  const fingerprint=latest ? latest.id+'\n'+Array.from(latest.content.matchAll(/\{\{theme::([^{}]+)\}\}/g),m=>m[1].trim()).join('\n') : '';
  return {
    observation:{sessionId,fingerprint},
    changed:!!previous&&previous.sessionId===sessionId&&previous.fingerprint!==fingerprint,
  };
}
