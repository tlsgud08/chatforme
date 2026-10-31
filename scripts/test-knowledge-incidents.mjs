import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const originalFetch = globalThis.fetch;
globalThis.window = { location: { origin: "https://incidents.test" } };
try {
  const { emptyState, applyPatch, knowledgeBlock } = await server.ssrLoadModule('/src/lib/knowledge/core.ts');
  const { consolidateIncidents } = await server.ssrLoadModule('/src/lib/knowledge/consolidate.ts');
  const { encounteredActors, readableSetup, pcProfileFacts, pcStatusFacts } = await server.ssrLoadModule('/src/lib/knowledge/evidence.ts');
  const { prepareKnowledge, replayContext, extractEntry } = await server.ssrLoadModule('/src/lib/knowledge/runtime.ts');
  const { DEFAULT_KNOWLEDGE_CONFIG: config } = await server.ssrLoadModule('/src/lib/knowledge/types.ts');
  const { supabase } = await server.ssrLoadModule('/src/lib/supabase.ts');
  const actors = [{ name: '히나', aliases: ['PC'], pc: true }, { name: '히유키', aliases: [], pc: false }, { name: '고용주', aliases: [], pc: false }];
  const narration = '**히유키** │ "멈춰라."\n```\n[관계]\n[ 고용주｜비즈니스 고용주 (0) ]\n```';
  assert.deepEqual(encounteredActors('히유키 암살을 의뢰받았다.', actors.slice(0, 1)), [], 'an assignment mentioning a target is not an encounter');
  assert.deepEqual(encounteredActors(narration, actors.slice(0, 1)).map(a => a.name), ['히유키', '고용주']);
  assert.deepEqual(encounteredActors(narration, actors), [], 'known actors are not duplicated');
  const setup = JSON.stringify({ work: '비밀 조직\nNPC 위장 신분', persona: { name: '히나', description: '요괴\n프리랜서 용병' } });
  assert.ok(readableSetup(setup).includes('요괴\n프리랜서 용병'));
  assert.ok(!readableSetup(setup).includes('\\n'), 'decoded quotes survive the exact-evidence validator');
  assert.equal(pcProfileFacts(setup, actors)[0].kind, 'pc');
  const status = '```\n[종족]｜요괴 (야코)\n[소속]｜무소속 (프리랜서 용병)\n[임무]｜히유키의 데이터 칩 회수\n[소지품]｜임무 브리핑 샤드\n[관계]\n[ 히유키｜대치 중 ]\n```';
  assert.equal(pcStatusFacts(status, actors.slice(0, 1)).length, 3, 'PC race, affiliation and mission cannot disappear if the model omits them');
  assert.ok(pcStatusFacts(status, actors.slice(0, 1)).every(f => f.kind === 'pc' && status.includes(f.quote)));
  assert.deepEqual(pcStatusFacts(status, actors.slice(0, 2)), [], 'do not attribute an unlabeled status to the wrong PC');
  assert.equal(pcStatusFacts(status.replace('요괴 (야코)', '미설정'), actors.slice(0, 1)).length, 2);
  const facts = ['히나가 요시와라에서 칼로 공격했다.', '히유키가 요시와라에서 공격을 막았다.', '전투 중 주변 시설이 파손됐다.'].map((text, i) => ({ id: 'f' + i, kind: 'event', text, quote: text, origin: 'assistant', secret: false, subjects: ['히나', '히유키'] }));
  const knowledge = facts.flatMap(f => actors.slice(0, 2).map(a => ({ fact: f.id, actor: a.name, status: 'knows', reason: a.name + '가 직접 전투에 참여했다.', source: 'm1', quote: f.quote })));
  const state = { actors, facts, knowledge, scene: ['히나', '히유키'] };
  const refs = new Map(facts.map((f, i) => ['F' + (i + 1), f]));
  const groups = [{ refs: ['F1', 'F2'], text: '히나와 히유키가 요시와라에서 전투했다.', reasons: [{ actor: '히나', reason: '전투에 직접 참여했다.', quote: facts[0].quote }] }];
  const patch = consolidateIncidents(state, groups, refs, 'm2');
  const compact = applyPatch(state, patch);
  assert.equal(compact.facts.length, 2, 'micro-actions collapse, independent damage remains');
  assert.equal(compact.facts.find(f => f.details)?.details.length, 2, 'original evidence is retained');
  assert.ok(compact.facts.some(f => f.id === 'f2'));
  assert.ok(!compact.knowledge.some(k => k.actor === '고용주'), 'off-scene employer does not learn the fight');
  assert.match(knowledgeBlock(compact), /O: 전투에 직접 참여했다/);
  assert.equal(compact.facts.find(f => f.details).details[0].knowledge[0].reason, knowledge[0].reason, 'original acquisition reasons remain inspectable');
  const checkRejected = changed => assert.equal(consolidateIncidents(changed, groups, refs, 'm2').facts.length, 0);
  checkRejected({ ...state, knowledge: knowledge.filter(k => !(k.fact === 'f1' && k.actor === '히나')) });
  for (const status of ['suspects', 'believes']) checkRejected({ ...state, knowledge: knowledge.map(k => k.fact === 'f1' ? { ...k, status } : k) });
  checkRejected({ ...state, knowledge: knowledge.map(k => k.fact === 'f1' ? { ...k, quote: '사용자 직접 정정' } : k) });
  for (const change of [{ secret: true }, { kind: 'pc' }, { kind: 'npc' }]) {
    const altered = new Map(refs); altered.set('F2', { ...facts[1], ...change });
    assert.equal(consolidateIncidents(state, groups, altered, 'm2').facts.length, 0);
  }
  assert.equal(consolidateIncidents(state, [{ refs: ['F1', 'N1'], text: '중복' }], new Map([...refs, ['N1', facts[0]]]), 'm2').facts.length, 0);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(setup)))).map(v => v.toString(16).padStart(2, '0')).join('');
  const context = { enabled: true, revision: 1, cost: 0, inputTokens: 0, outputTokens: 0, entries: [{ id: 'm1', source_hash: 'h1', setup_hash: hash, turn_index: 1, content_version: 0, content: narration, user_text: '', patch: state }] };
  let calls = 0, held = false, saved = 0;
  supabase.from = () => ({ select() { return this; }, eq() { return this; }, abortSignal() { return this; }, async single() { return { data: { knowledge_config: config } }; } });
  supabase.rpc = (name, args) => {
    let data = true;
    if (name === 'knowledge_context') data = structuredClone(context);
    else if (name === 'knowledge_lease') held = args.operation !== 'release';
    else if (name === 'save_knowledge_event') {
      assert.equal(held, false, 'cached repair CAS runs only after lease release');
      assert.deepEqual(args.expected_previous, context.entries[0].patch);
      context.entries[0].patch = args.desired; saved++;
    } else assert.equal(name, 'record_knowledge_call');
    const result = Promise.resolve({ data }); result.abortSignal = () => result; return result;
  };
  globalThis.fetch = async (_url, init) => {
    calls++;
    const request = JSON.parse(init.body), input = JSON.parse(request.messages[1].content);
    assert.ok(request.messages[0].content.includes('개별') || request.messages[0].content.includes('미세 행동'));
    assert.ok(request.response_format.json_schema.schema.properties.groups);
    const first = input.existing.find(f => f.text === facts[0].text), second = input.existing.find(f => f.text === facts[1].text);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...emptyState(), groups: [{ refs: [first.ref, second.ref], text: groups[0].text }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 } }));
  };
  const options = { sessionId: 'room', revision: 1, apiKey: 'fixture', setup, pcs: actors.slice(0, 1), signal: new AbortController().signal };
  const cached = await prepareKnowledge(options);
  assert.equal(calls, 0, 'software updates must not schedule paid historical repair');
  assert.equal(saved, 0);assert.equal(cached.processed,0);
  await prepareKnowledge(options);assert.equal(calls,0);
  // A decoded setup excerpt is accepted; escaped JSON text is not required from the recorder.
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);assert.ok(request.max_tokens <= 2000);
    const input = JSON.parse(request.messages[1].content);
    assert.ok(input.sources.setup.includes('요괴\n프리랜서 용병'));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...emptyState(), facts: [{ key: 'N1', kind: 'pc', text: '히나는 프리랜서 용병이다.', secret: false, subjects: ['히나'], source: 'setup', quote: '요괴\n프리랜서 용병' }], groups: [] }) } }], usage: {} }));
  };
  const decoded = await extractEntry('room', { ...context.entries[0], id: 'seed', turn_index: -1, content: '' }, { ...emptyState(), actors: actors.slice(0, 1) }, 'fixture', config, setup, options.signal);
  assert.ok(decoded.facts.some(f => f.text === '히나는 프리랜서 용병이다.'));
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...emptyState(), groups: [] }) } }], usage: {} }));
  const omitted = await extractEntry('room', { ...context.entries[0], id: 'status', content: status, turn_index: 2 }, { ...emptyState(), actors: actors.slice(0, 1) }, 'fixture', config, setup, options.signal);
  assert.equal(omitted.facts.filter(f => f.id.startsWith('pc-status:')).length, 3, 'model omission cannot drop explicit PC fields');
  assert.equal(omitted.knowledge.length, 0, 'status visibility alone does not fabricate anyone knowing a secret');
  console.log('Information incidents: meaningful grouping, original evidence, separate results, O/X/△/secret/manual boundaries, explicit roster, decoded setup, PC fallback, no automatic paid historical audit and exact replay passed.');
} finally { globalThis.fetch = originalFetch; delete globalThis.window; await server.close(); }
