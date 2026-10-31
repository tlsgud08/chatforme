import type { Fact, KnowledgeState } from './types';
import { visibleFact } from './core';
/** Bounded reference retrieval; storage and the main model retain the complete active knowledge. */
export function recorderFacts(state: KnowledgeState, source: string): Fact[] {
  const facts = state.facts.filter(f => visibleFact(f) || f.id.startsWith('pc-profile:'));
  const words = new Set(source.match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const ranked = facts.map((fact, index) => ({ fact, index, score: [...words].reduce((n, word) => n + (fact.text.includes(word) ? 1 : 0), 0) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, 12).map(item => item.fact);
  const selected = new Set([...facts.slice(-16), ...facts.filter(f => f.kind !== 'event').slice(-16), ...ranked]);
  return facts.filter(f => selected.has(f));
}
