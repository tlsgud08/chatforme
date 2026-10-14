import type { SavedTheme } from './theme';

export const DEFAULT_THEME_PROMPT = `장면의 장소, 시간, 분위기와 테마별 적용 조건을 판단하세요.
응답 맨 아래에 {{theme::테마이름}}을 한 개 출력하세요. 변경할 필요가 없으면 {{theme::keep}}을 출력하세요.
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
  return /\{\{theme::([^{}]+)\}\}\s*$/.exec(content)?.[1].trim() ?? null;
}
export function availableWorkThemes(themes: SavedTheme[], workId: string, userId: string): SavedTheme[] {
  return themes.filter(t => t.work_id === workId && (t.work_shared !== false || t.owner_id === userId));
}
export function themeCatalogPrompt(themes: SavedTheme[]): string {
  return [...themes].sort((a,b)=>a.id.localeCompare(b.id)).map(t =>
    `- 이름: ${t.name}\n  적용 조건: ${t.ai_prompt?.trim() || '별도 조건 없음'}`).join('\n\n');
}
export function resolveDirectiveTheme(name: string | null, themes: SavedTheme[]): SavedTheme | null {
  if (!name || name === 'keep') return null;
  const matches = themes.filter(t => t.name.trim() === name);
  // Ambiguous or unavailable names never select an arbitrary palette.
  return matches.length === 1 ? matches[0] : null;
}

export type ThemeObservation = { sessionId: string; fingerprint: string };
export function observeThemeDirective(previous: ThemeObservation | null, sessionId: string, latest: {id:string;content:string} | null) {
  const fingerprint=latest ? latest.id+'\n'+(finalThemeDirective(latest.content)??'') : '';
  return {
    observation:{sessionId,fingerprint},
    changed:!!previous&&previous.sessionId===sessionId&&previous.fingerprint!==fingerprint,
  };
}
