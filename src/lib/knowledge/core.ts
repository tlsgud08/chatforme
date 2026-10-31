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
  const retired = new Set([...facts.values()].flatMap(f => f.supersedes ?? []));
  for (const id of retired) facts.delete(id);
  const knowledge = new Map(
    state.knowledge.map((k) => [`${k.fact}\u0000${k.actor}`, k]),
  );
  for (const k of patch.knowledge) {
    if (!actors.has(k.actor) || !facts.has(k.fact)) continue;
    const key = `${k.fact}\u0000${k.actor}`;
    if (k.status === "unknown") {
      knowledge.delete(key);
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

export function knowledgeSymbol(status?: string) { return status === 'knows' ? 'O' : status === 'suspects' || status === 'believes' ? '△' : 'X'; }
const cell = (s: string) => s.replace(/\|/g, '／').replace(/[\r\n]+/g, ' ');
/** Full matrix: no omitted actors, facts, beliefs or acquisition reasons. */
export function knowledgeBlock(state: KnowledgeState): string {
  const actors = state.actors;
  const relations = new Map(state.knowledge.map(k => [`${k.fact}\0${k.actor}`, k]));
  return [
    '# 인물별 정보표 (참고 데이터)',
    'O=근거 있는 인지, △=의심/오해, X=인지 근거 없음. 인물별 상태는 서로 독립적이다.',
    `| 유형 | 정보 | ${actors.map(a => cell(a.name)).join(' | ')} |`,
    `| --- | --- | ${actors.map(() => '---').join(' | ')} |`,
    ...state.facts.map(f => `| ${f.kind} | ${cell(f.text)}${f.secret ? ' [비밀]' : ''} | ${actors.map(a => {
      const k = relations.get(`${f.id}\0${a.name}`);
      return k ? `${knowledgeSymbol(k.status)}: ${cell(k.reason)}${k.quote ? ' (근거: ' + cell(k.quote) + ')' : ''}` : 'X';
    }).join(' | ')} |`),
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
