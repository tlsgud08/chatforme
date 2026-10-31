import type { AssembledPrompt } from '../prompt/assemble';
import type { KnowledgeConfig, KnowledgePatch, KnowledgeState } from './types';
export const emptyState = (): KnowledgeState => ({ actors: [], facts: [], knowledge: [], scene: [] });
export function applyPatch(
  state: KnowledgeState,
  patch: KnowledgePatch,
): KnowledgeState {
  const actors = new Map(state.actors.map((a) => [a.name, a]));
  for (const a of patch.actors) {
    const old = actors.get(a.name);
    actors.set(a.name, {
      ...a,
      pc: a.pc || !!old?.pc,
      aliases: [...new Set([...(old?.aliases ?? []), ...a.aliases])],
    });
  }
  const facts = new Map(state.facts.map((f) => [f.id, f]));
  for (const f of patch.facts) if (!facts.has(f.id)) facts.set(f.id, f);
  for (const id of patch.detailFacts ?? []) {
    const fact = facts.get(id);
    if (fact?.kind === 'event' && !fact.secret && !state.knowledge.some(k => k.fact === id && k.quote === '사용자 직접 정정')) facts.set(id, { ...fact, detailOnly: true });
  }
  for (const id of patch.invalidFacts ?? []) facts.delete(id);
  for (const [id, fact] of facts) if (fact.kind === 'pc' && fact.subjects.length && !fact.subjects.some(n => [...actors.values()].some(a => a.pc && (a.name === n || a.aliases.includes(n))))) facts.set(id, { ...fact, kind: 'npc' });
  const retired = new Set([...facts.values()].flatMap(f => f.supersedes ?? []));
  for (const id of retired) facts.delete(id);
  const knowledge = new Map(
    state.knowledge.map((k) => [`${k.fact}\u0000${k.actor}`, k]),
  );
  for (const k of patch.knowledge) {
    if (!actors.has(k.actor) || !facts.has(k.fact)) continue;
    const key = `${k.fact}\u0000${k.actor}`;
    if (k.status === "unknown") {
      if (k.quote === '사용자 직접 정정') knowledge.set(key, k);
      else knowledge.delete(key);
      continue;
    }
    knowledge.set(key, k);
  }
  return {
    actors: [...actors.values()],
    facts: [...facts.values()],
    knowledge: [...knowledge.values()].filter(k => facts.has(k.fact)),
    scene: patch.scene,
  };
}

export const visibleFact = (f: import('./types').Fact) => !f.detailOnly && !f.id.startsWith('pc-profile:');
export function knowledgeSymbol(status?: string) { return status === 'knows' ? 'O' : status === 'suspects' || status === 'believes' ? '△' : 'X'; }
const cell = (s: string) => s.replace(/\|/g, '／').replace(/[\r\n]+/g, ' ');
/** Sparse lossless status map: omitted cells are X; original quotations stay in storage/UI. */
export function knowledgeBlock(state: KnowledgeState): string {
  const cells = new Map<string, typeof state.knowledge>();
  for (const k of state.knowledge) {
    const row = cells.get(k.fact) ?? []; row.push(k); cells.set(k.fact, row);
  }
  return [
    '# 인물별 정보표 (참고 데이터)',
    '등록 인물: ' + state.actors.map(a => cell(a.name) + (a.pc ? '(PC)' : '')).join(', '),
    'O=인지, △=의심/오해. 각 행에서 명시하지 않은 인물은 X(인지 근거 없음). 사용자 열람은 PC의 지식이 아니다.',
    ...state.facts.filter(visibleFact).map(f => `${f.kind}: ${cell(f.text)}${f.secret ? ' [비밀]' : ''} | ${(cells.get(f.id) ?? []).filter(k => k.status !== 'unknown').map(k => `${knowledgeSymbol(k.status)}: ${cell(k.reason)} [${cell(k.actor)}]`).join(' / ') || 'X'}`),
  ].join('\n');
}
/** OFF is the identical object: no labels, whitespace, history, cache or new calls. */
export function applyKnowledge(base: AssembledPrompt, enabled: boolean, config?: KnowledgeConfig, state?: KnowledgeState): AssembledPrompt {
  if (!enabled) return base;
  if (!config || !state) throw new Error('정보표를 준비하지 못했습니다.');
  return { ...base, systemParts: { ...base.systemParts,
    keywords: [base.systemParts.keywords, config.mainPrompt, knowledgeBlock(state)].filter(Boolean).join('\n\n'),
  } };
}
