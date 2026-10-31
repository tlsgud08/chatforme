import type { Actor, Fact } from './types';

/** Decode setup strings before quoting them: JSON escape sequences are not story text. */
export function readableSetup(raw: string): string {
  try {
    const lines: string[] = [];
    function walk(value: unknown, path: string) {
      if (typeof value === 'string' && value.trim()) lines.push(`${path}\n${value}`);
      else if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => walk(item, `${path}.${key}`));
    }
    walk(JSON.parse(raw), '설정');
    return lines.join('\n\n');
  } catch { return raw; }
}

export function pcSetup(raw: string): string {
  try {
    const data = JSON.parse(raw);
    return readableSetup(JSON.stringify(data.personas ?? data.persona ?? {}));
  } catch { return ''; }
}

/** Only explicit speaker labels / relationship rows count, never an arbitrary name mention. */
export function encounteredActors(text: string, known: Actor[]): Actor[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s*\*\*([^*\n]{1,100})\*\*\s*[│｜|:：]/gm)) names.add(match[1].trim());
  let relations = false;
  for (const line of text.split('\n')) {
    if (/^\s*(?:\[관계\]|관계\s*[:：]?|#{1,4}\s*(?:관계|등장인물))\s*$/.test(line)) { relations = true; continue; }
    if (!relations) continue;
    const match = line.match(/^\s*\[\s*([^\[\]│|｜\n]{1,100}?)\s*[│|｜].*\]\s*$/);
    if (match) names.add(match[1].trim());
    else if (line.trim() && !/^[-─`]+$/.test(line.trim())) relations = false;
  }
  return [...names].filter(name => !known.some(a => a.name === name || a.aliases.includes(name)))
    .map(name => ({ name, aliases: [], pc: false }));
}

/** A missing model row must not erase the explicitly configured PC profile. No knowledge is inferred. */
export function pcProfileFacts(setup: string, pcs: Actor[]): Fact[] {
  try {
    const data = JSON.parse(setup), profiles = data.personas ?? (data.persona ? [data.persona] : []);
    if (!Array.isArray(profiles)) return [];
    return profiles.flatMap((profile: { name?: string; description?: string }) => {
      const actor = pcs.find(a => a.name === profile.name || a.aliases.includes(profile.name ?? ''));
      if (!actor || typeof profile.description !== 'string' || !profile.description.trim()) return [];
      const description = profile.description.trim();
      // Full source is retained; the UI wraps it, and the recorder can derive separate supported facts.
      return [{ id: `pc-profile:${actor.name}`, kind: 'pc' as const, text: `${actor.name}의 기본 설정: ${description}`,
        subjects: [actor.name], secret: true, quote: description, origin: 'setup' }];
    });
  } catch { return []; }
}

/** Recognize the existing single-PC status window, with no inferred O for any character. */
export function pcStatusFacts(text: string, pcs: Actor[]): Fact[] {
  if (pcs.length !== 1) return []; // An unlabeled shared window cannot identify which PC it describes.
  const actor = pcs[0], facts: Fact[] = [];
  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const block = match[1];
    if (!/\[종족\]/.test(block) || !/\[소속\]/.test(block) || !/\[(?:소지품|관계)\]/.test(block)) continue;
    const name = block.match(/^\s*\[이름\]\s*[｜|│:]\s*(.+)$/m)?.[1].trim();
    if (name && !['미정', '미설정'].includes(name) && name !== actor.name && !actor.aliases.includes(name)) continue;
    for (const line of block.split('\n')) {
      const field = line.match(/^\s*\[(종족|소속|신분|임무|목적)\]\s*[｜|│:]\s*(.+?)\s*$/);
      if (!field || /^(?:미정|미설정|불명|알 수 없음|없음|-)\s*$/.test(field[2]) || field[2].length > 500) continue;
      const [, label, value] = field;
      facts.push({ id: `pc-status:${actor.name}:${label}:${value}`, kind: 'pc', text: `${actor.name} — ${label}: ${value}`,
        subjects: [actor.name], secret: true, quote: line.trim(), origin: 'assistant' });
    }
  }
  return facts;
}
