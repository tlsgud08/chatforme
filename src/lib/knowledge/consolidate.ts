import { emptyState } from './core';
import type { Fact, KnowledgePatch, KnowledgeState } from './types';

export interface IncidentGroup { refs: string[]; text: string; reasons?: { actor: string; reason: string; quote: string }[] }
/** Merge only equally known event details. Never transfer O from one detail to another. */
export function consolidateIncidents(state: KnowledgeState, groups: IncidentGroup[], references: Map<string, Fact>, source: string): KnowledgePatch {
  const patch = emptyState(), used = new Set<string>();
  const cells = new Map(state.knowledge.map(k => [`${k.fact}\0${k.actor}`, k]));
  for (const [index, group] of groups.entries()) {
    if (!group || !Array.isArray(group.refs) || group.refs.length < 2 || group.refs.length > 80 || typeof group.text !== 'string' || !group.text.trim() || group.text.length > 500) continue;
    const facts = [...new Set(group.refs)].map(ref => references.get(ref));
    if (facts.length < 2 || facts.some(f => !f || used.has(f.id))) continue;
    const rows = facts as Fact[], first = rows[0];
    if (new Set(rows.map(f => f.id)).size !== rows.length) continue;
    if (rows.some(f => f.kind !== 'event' || f.secret !== first.secret)) continue;
    // Suspicions and mistaken beliefs have different propositions even if both display △.
    if (state.actors.some(actor => {
      const values = rows.map(f => cells.get(`${f.id}\0${actor.name}`));
      return values.some(k => k?.status === 'suspects' || k?.status === 'believes' || k?.quote === '사용자 직접 정정') ||
        values.some(k => (k?.status ?? 'unknown') !== (values[0]?.status ?? 'unknown'));
    })) continue;
    const fact: Fact = { id: `${source}:incident:${index}`, kind: 'event', text: group.text.trim(), secret: first.secret,
      subjects: [...new Set(rows.flatMap(f => f.subjects))], supersedes: rows.map(f => f.id),
      details: rows.flatMap(f => f.details ?? [{ text: f.text, quote: f.quote, knowledge: state.knowledge.filter(k => k.fact === f.id) }]),
      quote: first.quote, origin: first.origin };
    patch.facts.push(fact);
    rows.forEach(f => used.add(f.id));
    for (const actor of state.actors) {
      const values = rows.map(f => cells.get(`${f.id}\0${actor.name}`)).filter(k => !!k);
      if (!values.length || values[0].status === 'unknown') continue;
      const summary = Array.isArray(group.reasons) ? group.reasons.find(r => r && r.actor === actor.name && typeof r.reason === 'string' && r.reason.trim() && r.reason.length <= 300 && typeof r.quote === 'string' && r.quote.trim() && values.some(k => k.quote.includes(r.quote))) : undefined;
      patch.knowledge.push({ ...values[0], fact: fact.id, source,
        reason: summary?.reason.trim() ?? [...new Set(values.map(k => k.reason))].join(' / '),
        quote: summary?.quote ?? [...new Set(values.map(k => k.quote))].join('\n') });
    }
  }
  return { ...patch, scene: state.scene };
}
