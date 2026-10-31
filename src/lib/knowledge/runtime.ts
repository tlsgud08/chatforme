import { registerAccountTask } from '../accountTasks';
import { supabase } from '../supabase';
import { stripThemeDirectives } from '../themeDirectives';
import { stripSyncDateTags } from '../syncDate';
import { emptyState, applyPatch } from './core';
import { structured, needsKnowledgeUpdate } from './model';
import { readableSetup, pcSetup, pcProfileFacts, pcStatusFacts, encounteredActors } from './evidence';
import { consolidateIncidents, type IncidentGroup } from './consolidate';
import { DEFAULT_KNOWLEDGE_CONFIG, type Actor, type Fact, type Knowledge, type KnowledgePatch, type KnowledgeState, type KnowledgeEntry, type KnowledgeConfig, type KnowledgeContext } from './types';
const INCIDENT_RULES = `
## 기록 단위와 누락 방지 (출력 형식 규칙)
사건은 “언제·누가·어디에서·무엇을 했는가”를 알 수 있는 장면 단위다. 전투의 베기·막기·회피·자세와 대사 한마디를 각각 사건으로 추가하지 않는다. 예: “히나와 히유키가 요시와라에서 전투했다.” 부상·파손·임무 성패·정체 노출 등 독립적으로 알아야 하는 결과만 별도 행으로 남긴다. 도서관에서 하루를 함께 보낸 일처럼 일상적인 사건도 기록한다.
이미 기록된 사건의 진행은 같은 사건을 참조한다. groups에는 같은 장면의 중복·미세 행동을 묶을 F#/N# refs와 사실만으로 쓴 대표 text를 반환한다. 서로 다른 날짜·장소의 사건, 결과와 숨겨진 범인·동기, 인지 상태가 다른 사실, 의심·오해의 명제는 합치지 않는다. 독립적인 부상·파손·비밀은 유지한다. 통합하지 않을 때 groups=[]. reasons에는 인지한 인물의 경위를 사건 단위로 짧게 요약하고, quote는 그 인물의 기존 인지 근거에서 그대로 가져온다. 예: 직접 전투 참여, 현장 목격, 실제 연락 수신. 없던 전달을 만들지 않는다. 원래 세부 경위와 근거는 코드가 보존한다.
PC의 배경·신분·종족·소속·목적·임무는 pc 유형이다. 설정의 persona/personas와 본문의 상태창을 확인한다. 미설정·미정은 사실로 만들지 않는다. 기존 PC 기본 설정 행만으로 모든 PC 정보가 기록됐다고 간주하지 않는다. INFO/관계창 또는 실제 대사·조우에 등장한 인물이 빠지지 않았는지 확인한다.
일반 서술/상태창에서 메타적으로 확인되는 사실은 그 자체로 타 인물이 알게 된 근거가 아니다. 대사를 들었다면 그 발언을 들은 것이며 발언 속 주장·추측이 진실임을 알게 된 것은 아니다.`;
const textSchema = { type: "string" },
  boolSchema = { type: "boolean" };
const array = (items: unknown) => ({ type: "array", items });
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
interface Extraction {
  actors: (Actor & { quote: string })[];
  facts: {
    key: string;
    kind: Fact["kind"];
    text: string;
    secret: boolean;
    subjects: string[];
    source: string;
    quote: string;
  }[];
  knowledge: {
    fact: string;
    actor: string;
    status: Knowledge["status"];
    reason: string;
    source: string;
    quote: string;
    informer: string;
  }[];
  scene: string[];
  groups?: IncidentGroup[];
}
const extractionSchema = object({
  actors: array(
    object({ name: textSchema, aliases: array(textSchema), pc: boolSchema, quote: textSchema }),
  ),
  facts: array(
    object({
      key: textSchema,
      kind: { type: "string", enum: ["pc", "event", "npc"] },
      text: textSchema,
      secret: boolSchema,
      subjects: array(textSchema),
      source: { type: "string", enum: ["user", "assistant", "setup"] },
      quote: textSchema,
    }),
  ),
  knowledge: array(
    object({
      fact: textSchema,
      actor: textSchema,
      status: { type: "string", enum: ["knows", "suspects", "believes", "unknown"] },
      reason: textSchema,
      source: { type: "string", enum: ["user", "assistant", "setup"] },
      quote: textSchema,
      informer: textSchema,
    }),
  ),
  scene: array(textSchema),
  groups: array(object({ refs: array(textSchema), text: textSchema, reasons: array(object({ actor: textSchema, reason: textSchema, quote: textSchema })) })),
});
export const cleanNarrative = (s: string) =>
  stripSyncDateTags(stripThemeDirectives(s));
const bounded = (s: unknown, max: number): s is string =>
  typeof s === "string" && s.trim().length > 0 && s.length <= max;
const strings = (s: unknown, max = 100): s is string[] =>
  Array.isArray(s) && s.length <= max && s.every((v) => bounded(v, 100));
/** Cross-tab lease avoids duplicate paid extraction after the main response commits. */
async function withKnowledgeLease<T>(
  sessionId: string,
  signal: AbortSignal,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const token = crypto.randomUUID(),
    started = Date.now();
  const lease = async (operation: string) => {
    const { data, error } = await supabase.rpc("knowledge_lease", {
      target_session: sessionId,
      lease_token: token,
      operation,
    });
    if (error) throw error;
    return data === true;
  };
  while (!(await lease("claim"))) {
    signal.throwIfAborted();
    if (Date.now() - started > 180000)
      throw new Error(
        "다른 화면에서 정보를 정리하고 있어요. 잠시 후 다시 시도해 주세요.",
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const lost = new AbortController(),
    combined = AbortSignal.any([signal, lost.signal]);
  const heartbeat = setInterval(() => {
    void lease("renew")
      .then((ok) => {
        if (!ok) lost.abort();
      })
      .catch(() => lost.abort());
  }, 30000);
  try {
    combined.throwIfAborted();
    return await task(combined);
  } finally {
    clearInterval(heartbeat);
    await lease("release").catch(() => {});
  }
}
export function replayContext(context: KnowledgeContext): {
  state: KnowledgeState;
  pending: KnowledgeEntry[];
} {
  let state = emptyState(),
    stale = false;
  const pending: KnowledgeEntry[] = [];
  for (const row of context.entries) {
    if (!row.patch) stale = true;
    if (stale) pending.push(row);
    else state = applyPatch(state, row.patch!);
  }
  return { state, pending };
}
function chunks(text: string) {
  const out: string[] = [];
  for (let start = 0; start < text.length; start += 10000)
    out.push(text.slice(start, start + 10000));
  return out.length ? out : [""];
}

export async function extractEntry(
  sessionId: string,
  entry: KnowledgeEntry,
  state: KnowledgeState,
  apiKey: string,
  prompts: KnowledgeConfig,
  setup: string,
  signal: AbortSignal,
  repair = false,
): Promise<KnowledgePatch> {
  const foundActors = encounteredActors(cleanNarrative(entry.content), state.actors);
  let interim = applyPatch(state, { ...emptyState(), actors: foundActors, scene: state.scene });
  const finalPatch = { ...emptyState(), actors: foundActors };
  const userParts = chunks(cleanNarrative(entry.user_text)),
    assistantParts = chunks(cleanNarrative(entry.content));
  // Never truncate a long source silently: process separate bounded fragments.
  const profileParts = chunks(pcSetup(setup));
  const fragments = repair ? Array.from({ length: Math.max(userParts.length, assistantParts.length, profileParts.length) }, (_, i) => ({
    user: userParts[i] ?? '', assistant: assistantParts[i] ?? '', setup: profileParts[i] ?? '',
  })) : [
    ...(entry.turn_index === -1
      ? chunks(readableSetup(setup))
          .filter(Boolean)
          .map((text) => ({ user: "", assistant: "", setup: text }))
      : []),
    ...Array.from(
      { length: Math.max(userParts.length, assistantParts.length) },
      (_, i) => ({
        user: userParts[i] ?? "",
        assistant: assistantParts[i] ?? "",
        setup: "",
      }),
    ),
  ].filter(part => part.setup || part.user || part.assistant);
  for (let index = 0; index < fragments.length; index++) {
    signal.throwIfAborted();
    const sources = fragments[index];
    const found = encounteredActors(sources.assistant, interim.actors);
    interim = applyPatch(interim, { ...emptyState(), actors: found, scene: interim.scene });
    finalPatch.actors.push(...found);
    const pcs = interim.actors.filter(a => a.pc);
    const profiles = [...pcProfileFacts(setup, pcs), ...pcStatusFacts(sources.assistant, pcs)].filter(f => !interim.facts.some(old => old.id === f.id));
    interim = applyPatch(interim, { ...emptyState(), facts: profiles, scene: interim.scene });
    finalPatch.facts.push(...profiles);
    const relevant = interim.facts;
    const references = Object.fromEntries(
      relevant.map((f, i) => [`F${i + 1}`, f]),
    );
    const existing = relevant.map((f, i) => ({
      ref: `F${i + 1}`,
      kind: f.kind,
      text: f.text,
      secret: f.secret,
      quote: f.quote, origin: f.origin, subjects: f.subjects,
      knowers: interim.knowledge
        .filter((k) => k.fact === f.id && k.status === "knows")
        .map((k) => k.actor),
    }));
    const output = await structured<Extraction>(
      { apiKey, sessionId, model: prompts.model, reasoning: prompts.reasoning, signal },
      prompts.recordPrompt +
        "\nReturn JSON changes only. facts.key uses N1,N2... for new facts; knowledge.fact references an existing F# or a new N#. All evidence quotes must be exact substrings of the indicated user/assistant/setup source. Do not register every name in setup: only PCs and characters encountered in the actual scene or INFO. Keep every registered actor, including absent/dead/hostile actors. Return current scene names; do not treat every INFO entry as physically present. No arbitrary deletion. Use groups only for incident consolidation. Setup can establish a character knowing their own identity only when explicitly supported. Do not make intentions into completed events. User action text alone does not prove a successful event: require the assistant result for completed outcomes. Return every supported change in this fragment; do not omit facts to fill an arbitrary quota. For a new actor, quote must be an exact assistant-source excerpt demonstrating INFO registration or encounter. Never create new actor columns from setup alone. For setup evidence in later turns, quote the provided setup fragment or exact originating quotes on existing facts whose origin is setup. Known facts are reference material, not fresh events.\n" +
        INCIDENT_RULES,
      { sources, actors: interim.actors, existing, knowledge: interim.knowledge, scene: interim.scene },
      extractionSchema,
      prompts.maxOutputTokens,
    );
    if (
      !Array.isArray(output.actors) ||
      !Array.isArray(output.facts) ||
      !Array.isArray(output.knowledge) ||
      !strings(output.scene)
    )
      throw new Error("정보 추출 형식이 올바르지 않습니다.");
    if (
      output.actors.length > 80 ||
      output.facts.length > 80 ||
      output.knowledge.length > 200 ||
      (output.groups !== undefined && (!Array.isArray(output.groups) || output.groups.length > 80))
    )
      throw new Error("한 번에 너무 많은 정보 기록이 생성되었습니다.");
    const patch = emptyState(),
      validActors = new Map(interim.actors.map((a) => [a.name, a]));
    for (const a of output.actors) {
      if (
        !bounded(a.name, 100) ||
        !strings(a.aliases, 15) ||
        typeof a.pc !== "boolean"
      )
        throw new Error("잘못된 인물 기록입니다.");
      const aliasMatches = [...validActors.values()].filter((v) =>
        v.aliases.includes(a.name) || a.aliases.includes(v.name),
      );
      const old =
        validActors.get(a.name) ??
        (aliasMatches.length === 1 ? aliasMatches[0] : undefined);
      if (!old && (!bounded(a.quote, 800) || !sources.assistant.includes(a.quote) || ![a.name, ...a.aliases].some(name => a.quote.includes(name)))) continue;
      const actor = old
        ? { ...old, aliases: [...new Set([...old.aliases, ...a.aliases, ...(a.name !== old.name ? [a.name] : [])])] }
        : { name: a.name, aliases: a.aliases, pc: false };
      validActors.set(actor.name, actor);
      patch.actors.push(actor);
    }
    const factMap = new Map<string, Fact>(Object.entries(references));
    const evidence = (source: string, quote: string) =>
      ["user", "assistant", "setup"].includes(source) &&
      bounded(quote, 800) &&
      ((sources[source as keyof typeof sources] || "").includes(quote) || (source === "setup" && interim.facts.some(f => f.origin === "setup" && f.quote?.includes(quote))));
    for (const f of output.facts) {
      if (
        !bounded(f.key, 30) ||
        !/^N\d+$/.test(f.key) ||
        factMap.has(f.key) ||
        !bounded(f.text, 500) ||
        !["pc", "event", "npc"].includes(f.kind) ||
        typeof f.secret !== "boolean" ||
        !strings(f.subjects, 20)
      )
        throw new Error("잘못된 사실 기록입니다.");
      if (!evidence(f.source, f.quote)) continue;
      const old =
        interim.facts.find((v) => v.text === f.text) ??
        patch.facts.find((v) => v.text === f.text);
      const fact = old ?? {
        id: `${entry.id}:${index}:${f.key}`,
        kind: f.kind,
        text: f.text,
        secret: f.secret,
        quote: f.quote, origin: f.source,
        subjects: f.subjects.map((n) => {
          const matches = [...validActors.values()].filter(
            (a) => a.name === n || a.aliases.includes(n),
          );
          return matches.length === 1 ? matches[0].name : n;
        }),
      };
      factMap.set(f.key, fact);
      if (!old) patch.facts.push(fact);
    }
    
    for (const k of output.knowledge) {
      const fact = factMap.get(k.fact),
        matches = [...validActors.values()].filter(
          (a) => a.name === k.actor || a.aliases.includes(k.actor),
        );
      const actor =
        validActors.get(k.actor) ??
        (matches.length === 1 ? matches[0] : undefined);
      if (
        !fact ||
        !actor ||
        !evidence(k.source, k.quote) ||
        !bounded(k.reason, 300) ||
        !["knows", "suspects", "believes", "unknown"].includes(k.status)
      )
        continue;
      const knowledge: Knowledge = {
        fact: fact.id,
        actor: actor.name,
        status: k.status,
        reason: k.reason,
        source: entry.id,
        quote: k.quote,
      };
      patch.knowledge.push(knowledge);
    }
    const mergedState = applyPatch(interim, patch);
    const grouped = consolidateIncidents(mergedState, Array.isArray(output.groups) ? output.groups : [], factMap, `${entry.id}:${index}`);
    patch.facts.push(...grouped.facts); patch.knowledge.push(...grouped.knowledge);
    patch.scene = output.scene.filter((n) => validActors.has(n));
    // A setup-only fragment must not move the actual scene.
    if (sources.setup && !sources.assistant) patch.scene = interim.scene;
    interim = applyPatch(interim, patch);
    finalPatch.actors.push(...patch.actors);
    finalPatch.facts.push(...patch.facts);
    finalPatch.knowledge.push(...patch.knowledge);
    finalPatch.scene = patch.scene;
  }
  return { ...finalPatch, formatVersion: 2 };
}


export async function loadKnowledgeConfig(signal?: AbortSignal): Promise<KnowledgeConfig> {
  let q = supabase.from('platform_config').select('knowledge_config').eq('id', 1);
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q.single();
  if (error || !data) throw error ?? new Error('정보 관리 설정 조회 실패');
  return { ...DEFAULT_KNOWLEDGE_CONFIG, ...data.knowledge_config };
}
export async function readKnowledgeContext(sessionId: string, beforeTurn = 2147483647, signal?: AbortSignal): Promise<KnowledgeContext> {
  let q = supabase.rpc('knowledge_context', { target_session: sessionId, before_turn: beforeTurn });
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q;
  if (error || !data) throw error ?? new Error('정보표 조회 실패');
  return data as KnowledgeContext;
}
export interface KnowledgeOptions {
  sessionId: string; revision: number; apiKey: string; signal: AbortSignal;
  beforeTurn?: number; setup: string; pcs: Actor[];
  onProgress?: (processed: number, total: number) => void;
}
export async function prepareKnowledge(o: KnowledgeOptions) {
  const config = await loadKnowledgeConfig(o.signal);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(o.setup)))).map(v => v.toString(16).padStart(2, '0')).join('');
  const result = await withKnowledgeLease(o.sessionId, o.signal, async signal => {
    const context = await readKnowledgeContext(o.sessionId, o.beforeTurn, signal);
    if (!context.enabled || context.revision !== o.revision) throw new Error('정보 관리 설정이 변경되었습니다. 다시 전송해 주세요.');
    const replay = replayContext({ ...context, entries: context.entries.map(e => ({ ...e, patch: e.setup_hash === hash ? e.patch : null })) });
    let state = applyPatch(replay.state, { ...emptyState(), actors: o.pcs, scene: replay.state.scene });
    const completed = context.entries.slice(0, context.entries.length - replay.pending.length);
    for (const entry of completed) state = applyPatch(state, { ...emptyState(), actors: encounteredActors(cleanNarrative(entry.content), state.actors), scene: state.scene });
    o.onProgress?.(0, replay.pending.length);
    const last = completed.at(-1);
    const needsRepair = !!last?.patch && last.patch.formatVersion !== 2;
    // Old records are compacted from their stored evidence, rather than paying to replay the whole history.
    // Existing CAS forbids manual rewrites during a lease, so stage the change and publish after release.
    if (needsRepair && !replay.pending.length && o.beforeTurn === undefined) {
      o.onProgress?.(0, 1);
      const repair = await extractEntry(o.sessionId, { ...last, id: `${last.id}:repair2` }, state, o.apiKey, config, o.setup, signal, true);
      repair.actors.unshift(...state.actors);
      repair.scene = state.scene;
      const desired = { ...repair, actors: [...last.patch!.actors, ...repair.actors], facts: [...last.patch!.facts, ...repair.facts], knowledge: [...last.patch!.knowledge, ...repair.knowledge] };
      return { config, state: applyPatch(state, repair), processed: 1, repair: { last, desired } };
    }
    for (const [index, entry] of replay.pending.entries()) {
      const repair = needsRepair && index === 0;
      const roster = encounteredActors(cleanNarrative(entry.content), state.actors);
      const missingPcFields = pcStatusFacts(cleanNarrative(entry.content), state.actors.filter(a => a.pc)).some(f => !state.facts.some(old => old.id === f.id));
      const changed = repair || entry.turn_index === -1 || roster.length > 0 || missingPcFields || await needsKnowledgeUpdate(
        { apiKey: o.apiKey, sessionId: o.sessionId, model: config.detectorModel, signal },
        config.detectorPrompt + '\n이미 기록된 같은 전투·방문 장면의 개별 공격·방어·회피·반복 대사만 이어지면 새 사건이 아니다. 별도 기록할 부상·피해·성패·정체 노출·인지 변화가 없다면 false로 판단할 수 있다. 누구와 어디에서 시간을 보냈는지 같은 새 일상 사건은 유지한다.',
        {
          user: cleanNarrative(entry.user_text), assistant: cleanNarrative(entry.content),
          registeredActors: state.actors.map(a => a.name),
          recentFacts: state.facts.slice(-6).map(f => f.text),
        },
      );
      const patch = changed
        ? await extractEntry(o.sessionId, entry, state, o.apiKey, config, o.setup, signal, repair)
        : { ...emptyState(), scene: state.scene, formatVersion: 2 };
      // Persist the deterministic roster as well, including PCs and previously missed speakers.
      patch.actors.unshift(...state.actors);
      signal.throwIfAborted();
      const { data, error } = await supabase.rpc('save_knowledge_event', {
        target_session: o.sessionId, target_message: entry.id, expected_hash: entry.source_hash,
        desired: patch, setup_hash: hash, expected_revision: o.revision,
      });
      if (error || data !== true) throw error ?? new Error('정보표를 저장하지 못했습니다.');
      state = applyPatch(state, patch);
      o.onProgress?.(index + 1, replay.pending.length);
    }
    return { config, state, processed: replay.pending.length, repair: null };
  });
  if (result.repair) {
    o.signal.throwIfAborted();
    const { last, desired } = result.repair;
    const { data, error } = await supabase.rpc('save_knowledge_event', {
      target_session: o.sessionId, target_message: last.id, expected_hash: last.source_hash,
      desired, setup_hash: hash, expected_revision: o.revision, expected_previous: last.patch,
    });
    if (error || data !== true) throw error ?? new Error('정보표가 변경되었습니다. 다시 갱신해 주세요.');
    o.onProgress?.(1, 1);
  }
  return { config: result.config, state: result.state, processed: result.processed };
}

const background = new Map<string, { controller: AbortController; promise: Promise<void> }>();
export function cancelKnowledge(sessionId: string) { background.get(sessionId)?.controller.abort(); }
/** Post-commit extraction never holds up the composer. The next send waits on the DB lease. */
export function queueKnowledge(options: KnowledgeOptions): Promise<void> {
  const existing = background.get(options.sessionId);
  if (existing && !existing.controller.signal.aborted) return existing.promise;
  const controller = new AbortController(), unregister = registerAccountTask(controller);
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const promise = prepareKnowledge({ ...options, signal }).then(() => {
    if (!signal.aborted && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('inuchat:knowledge-updated', { detail: options.sessionId }));
  }).catch(error => { if (!signal.aborted) throw error; }).finally(() => {
    unregister();
    if (background.get(options.sessionId)?.controller === controller) background.delete(options.sessionId);
  });
  background.set(options.sessionId, { controller, promise });
  return promise;
}
