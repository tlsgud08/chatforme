import { emptyState } from './core';
import { encounteredActors, pcStatusFacts } from './evidence';
import type { Fact, KnowledgeEntry, KnowledgePatch, KnowledgeState } from './types';

/** Only public visual traits; an opaque persona can also contain hidden identity and goals. */
export function appearanceFact(profile: Fact): Fact | null {
  const traits = (profile.quote ?? '').split(/[+\n,]/).map(s => s.trim()).filter(s =>
    /머리|앞머리|눈매|눈동자|붉은눈|외모|체구|여우귀|고양이귀|강아지귀|늑대귀|꼬리/.test(s) &&
    !/비밀|숨|가면|변장|문신|흉터|가슴|성기|목적|과거|능력|정체|실제|본모습/.test(s));
  if (!traits.length || profile.subjects.length !== 1) return null;
  return { ...profile, id: `pc-appearance:${profile.subjects[0]}`, text: `${profile.subjects[0]}의 겉으로 보이는 외모: ${traits.join(', ')}`, secret: false, aspect: 'appearance' };
}

/** Conservative evidence shortcuts, not a blanket “everyone in the scene knows everything”. */
export function awarenessPatch(state: KnowledgeState, entries: KnowledgeEntry[]): KnowledgePatch {
  const patch: KnowledgePatch = emptyState();
  const actors = state.actors.map(a => ({ ...a }));
  for (const entry of entries) {
    const roster = encounteredActors(entry.content, []);
    for (const item of roster) {
      const known = actors.find(a => a.name === item.name || a.aliases.includes(item.name));
      if (!known) { const added = { ...item, unprocessed: !entry.patch }; actors.push(added); patch.actors.push(added); }
      else if (entry.patch && known.unprocessed) { known.unprocessed = false; patch.actors.push({ ...known, unprocessed: false }); }
    }
  }
  patch.invalidFacts = state.facts.filter(f => !f.subjects.some(n => actors.some(a => a.pc && (a.name === n || a.aliases.includes(n)))) && /^\[(종족|소속|신분|임무|목적|장비)\][｜|│:]/.test(f.quote?.trim() ?? '') && entries.some(entry => f.id.startsWith(entry.id) && pcStatusFacts(entry.content, actors.filter(a => a.pc)).length > 0 && (pcStatusFacts(entry.content, actors.filter(a => a.pc)).some(field => field.quote === f.quote) || f.quote!.startsWith('[장비]')))).map(f => f.id);
  const appearance = state.facts.filter(f => f.id.startsWith('pc-profile:')).map(appearanceFact).filter((f): f is Fact => !!f);
  patch.facts.push(...appearance.filter(f => !state.facts.some(old => old.id === f.id)));
  for (const fact of appearance) if (!state.knowledge.some(k => k.fact === fact.id && k.actor === fact.subjects[0] && k.quote === '사용자 직접 정정') && !(fact.quote ?? '').includes('기억상실')) patch.knowledge.push({ fact: fact.id, actor: fact.subjects[0], status: 'knows', reason: '본인의 설정에 명시된 겉으로 보이는 외형이다. 숨겨진 신분·목적은 포함하지 않는다.', quote: fact.quote ?? '', source: 'setup' });
  const facts = [...state.facts, ...patch.facts];
  const protectedCell = (fact: string, actor: string) => state.knowledge.some(k => k.fact === fact && k.actor === actor && (k.quote === '사용자 직접 정정' || k.status === 'suspects' || k.status === 'believes'));
  for (const entry of entries) {
    for (const fact of facts) {
      if (!fact.quote) continue;
      // The speaker knows having issued their own instruction/promise; its promised outcome is not assumed true.
      if (fact.kind === 'event' && /의뢰|지시|명령|약속|제안/.test(fact.text) && /제시|말했다|했다|넘기겠|제안/.test(fact.text)) {
        const speech = [...entry.content.matchAll(/\*\*([^*\n]+)\*\*\s*[│｜|:：]\s*([^\n]+)/g)]
          .find(m => m[2].includes(fact.quote!) && fact.text.startsWith(m[1].trim()));
        const actor = speech && actors.find(a => a.name === speech[1].trim() || a.aliases.includes(speech[1].trim()));
        if (actor && !protectedCell(fact.id, actor.name)) patch.knowledge.push({ fact: fact.id, actor: actor.name, status: 'knows', reason: '본인이 직접 해당 의뢰·지시·약속을 말했다. 약속한 결과의 실현 여부와는 별개다.', quote: speech![0], source: entry.id });
      }
      if (fact.aspect !== 'appearance') continue;
      const pc = fact.subjects[0];
      for (const actor of actors.filter(a => a.name !== pc)) {
        if (protectedCell(fact.id, actor.name)) continue;
        const names = [actor.name, ...actor.aliases];
        const short = actor.name.split(' ').at(-1)!;
        if (actors.filter(a => a.name.split(' ').at(-1) === short).length === 1) names.push(short);
        const witness = entry.content.split(/\n\s*\n/).find(p => p.includes(pc) && names.some(n => p.includes(n)) && /응시|바라보|마주\s*보|올려다보|내려다보/.test(p) && !/통신|스피커|전화|홀로그램|영상|사진|실명|장님|가면|변장|보이지|못\s*보/.test(p));
        if (witness) patch.knowledge.push({ fact: fact.id, actor: actor.name, status: 'knows', reason: `${pc}를 직접 바라본 장면에서 겉으로 보이는 외모를 확인했다. 숨겨진 신분·목적은 포함하지 않는다.`, quote: witness, source: entry.id });
      }
    }
  }
  patch.scene = state.scene;
  return patch;
}
