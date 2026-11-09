import type { Profile, Session } from '@/types/db';

export function summaryNarrativeConfig(profile: Partial<Profile>, session: Partial<Session>) {
  return {
    unit: 'characters' as const,
    enabled: session.summary_parameters_enabled_override ?? profile.summary_parameters_enabled ?? true,
    target: session.summary_narrative_target_chars_override?.trim() || profile.summary_narrative_target_chars?.trim() || '10000',
  };
}

/** Parse supported numeric targets without guessing a number out of arbitrary instructions. */
export function parseSummaryTarget(raw: string): { minimum: number; maximum: number } | null {
  const value = raw.normalize('NFKC').trim().replace(/^(?:약|about|approximately)\s*/i, '')
    .replace(/\s*(?:자|글자|characters?)$/i, '').trim();
  const number = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)';
  const match = new RegExp(`^(${number})(?:\\s*(?:~|～|–|—|-)\\s*(${number}))?$`).exec(value);
  if (!match) return null;
  const minimum = Number(match[1].replace(/,/g, ''));
  const maximum = Number((match[2] ?? match[1]).replace(/,/g, ''));
  return Number.isSafeInteger(minimum) && minimum > 0 && Number.isSafeInteger(maximum) && maximum >= minimum
    ? { minimum, maximum } : null;
}

const otherSections = new Set(['[메타정보]', '[주요인물]', '[주요 약속/계획]', '[주요 갈등]', '[종합 상황]']);
const heading = (line: string) => line.trim().replace(/^#{1,6}\s*/, '').replace(/\*\*|__/g, '').replace(/\s*[:：]\s*$/, '').trim();

/** Only section headings delimit the narrative; dates and quoted/code examples do not. */
export function extractCoreNarrative(text: string): string | null {
  let lines = text.trim().split(/\r?\n/);
  const wrapper = /^\s*(`{3,}|~{3,})[^`~]*$/.exec(lines[0] ?? '');
  if (wrapper && lines.length > 1) {
    const closing = new RegExp(`^\\s*${wrapper[1][0]}{${wrapper[1].length},}\\s*$`);
    if (closing.test(lines.at(-1)!) && !lines.slice(1, -1).some(line => closing.test(line))) lines = lines.slice(1, -1);
  }
  const body: string[] = [];
  let found = false, finished = false;
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      if (found && !finished) body.push(line);
      continue;
    }
    if (!fence) {
      const label = heading(line);
      if (label === '[핵심 서사 및 맥락]') {
        if (found) return null; // Ambiguous duplicate sections must not produce a misleading percentage.
        found = true;
        continue;
      }
      if (found && (otherSections.has(label) || /^===\s*요약 내용 끝/.test(label))) finished = true;
    }
    if (found && !finished) body.push(line);
  }
  return found ? body.join('\n').trim() : null;
}

/** Count visible Unicode graphemes; spaces count, line breaks do not. */
export function countNarrativeCharacters(text: string): number {
  const normalized = text.normalize('NFC').replace(/[\r\n\u2028\u2029]/g, '');
  const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
  let count = 0;
  for (const _segment of segmenter.segment(normalized)) count += 1;
  return count;
}

export function summaryAchievementToast(text: string, config: ReturnType<typeof summaryNarrativeConfig>, reason?: string | null) {
  const status = reason === 'stop' ? '요약 저장 완료'
    : reason === 'user_stop' ? '사용자 중지 · 수신한 내용 저장'
    : reason === 'stream_error' ? '수신 중단 · 받은 내용 저장'
    : reason === 'length' ? '출력 제한으로 중단 · 받은 내용 저장'
    : reason === 'content_filter' ? '제공자 필터로 중단 · 받은 내용 저장'
    : reason === 'error' ? '제공자 오류로 중단 · 받은 내용 저장' : '종료 상태 미확인 · 받은 내용 저장';
  const result = (detail: string, warning = false) => ({
    message: `${status} · ${detail}`,
    tone: warning || reason !== 'stop' ? 'warning' as const : 'success' as const,
    durationMs: 6500,
  });
  if (!config.enabled) return result('분량 목표 미적용 (파라미터 전송 OFF)');
  const target = parseSummaryTarget(config.target);
  if (!target) return result('목표 분량 해석 불가', true);
  const narrative = extractCoreNarrative(text);
  if (narrative === null) return result('핵심 서사 분량 확인 불가', true);
  const characters = countNarrativeCharacters(narrative);
  const percent = Math.round(characters / target.minimum * 100);
  const rangeLabel = target.minimum !== target.maximum ? ' · 범위 하한 대비' : '';
  return result(`핵심 서사 ${percent.toLocaleString('ko-KR')}% (${characters.toLocaleString('ko-KR')} / ${target.minimum.toLocaleString('ko-KR')}자) 달성${rangeLabel}`, characters < target.minimum);
}
