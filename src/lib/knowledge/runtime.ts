import { registerAccountTask } from '../accountTasks';
import { supabase } from '../supabase';
import { stripThemeDirectives } from '../themeDirectives';
import { stripSyncDateTags } from '../syncDate';
import { emptyState, applyPatch } from './core';
import { structured } from './model';
import { DEFAULT_KNOWLEDGE_CONFIG, type Actor, type Fact, type Knowledge, type KnowledgePatch, type KnowledgeState, type KnowledgeEntry, type KnowledgeConfig, type KnowledgeContext } from './types';
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
): Promise<KnowledgePatch> {
  let interim = state;
  const finalPatch = emptyState();
  const userParts = chunks(cleanNarrative(entry.user_text)),
    assistantParts = chunks(cleanNarrative(entry.content));
  // Never truncate a long source silently: process separate bounded fragments.
  const fragments = [
    ...(entry.turn_index === -1
      ? chunks(setup)
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
    const relevant = interim.facts;
    const references = Object.fromEntries(
      relevant.map((f, i) => [`F${i + 1}`, f]),
    );
    const existing = relevant.map((f, i) => ({
      ref: `F${i + 1}`,
      text: f.text,
      secret: f.secret,
      knowers: interim.knowledge
        .filter((k) => k.fact === f.id && k.status === "knows")
        .map((k) => k.actor),
    }));
    const output = await structured<Extraction>(
      { apiKey, sessionId, model: prompts.model, reasoning: prompts.reasoning, signal },
      prompts.recordPrompt +
        "\nReturn JSON changes only. facts.key uses N1,N2... for new facts; knowledge.fact references an existing F# or a new N#. All evidence quotes must be exact substrings of the indicated user/assistant/setup source. Do not register every name in setup: only PCs and characters encountered in the actual scene or INFO. Keep every registered actor, including absent/dead/hostile actors. Return current scene names; do not treat every INFO entry as physically present. No deletion. Setup can establish a character knowing their own identity only when explicitly supported. Do not make intentions into completed events. User action text alone does not prove a successful event: require the assistant result for completed outcomes. Return every supported change in this fragment; do not omit facts to fill an arbitrary quota. For a new actor, quote must be an exact assistant-source excerpt demonstrating INFO registration or encounter. Never create new actor columns from reference_setup alone. reference_setup is immutable reference material, not a new event; setup evidence may quote it for established identities and prior knowledge.",
      { sources, reference_setup: setup, actors: interim.actors, existing, knowledge: interim.knowledge, scene: interim.scene },
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
      output.knowledge.length > 200
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
      (sources[source as keyof typeof sources] || (source === "setup" ? setup : "")).includes(quote);
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
    patch.scene = output.scene.filter((n) => validActors.has(n));
    // A setup-only fragment must not move the actual scene.
    if (sources.setup) patch.scene = interim.scene;
    interim = applyPatch(interim, patch);
    finalPatch.actors.push(...patch.actors);
    finalPatch.facts.push(...patch.facts);
    finalPatch.knowledge.push(...patch.knowledge);
    finalPatch.scene = patch.scene;
  }
  return finalPatch;
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
}
export async function prepareKnowledge(o: KnowledgeOptions) {
  const config = await loadKnowledgeConfig(o.signal);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(o.setup)))).map(v => v.toString(16).padStart(2, '0')).join('');
  return withKnowledgeLease(o.sessionId, o.signal, async signal => {
    const context = await readKnowledgeContext(o.sessionId, o.beforeTurn, signal);
    if (!context.enabled || context.revision !== o.revision) throw new Error('정보 관리 설정이 변경되었습니다. 다시 전송해 주세요.');
    const replay = replayContext({ ...context, entries: context.entries.map(e => ({ ...e, patch: e.setup_hash === hash ? e.patch : null })) });
    let state = applyPatch(replay.state, { ...emptyState(), actors: o.pcs, scene: replay.state.scene });
    for (const entry of replay.pending) {
      const patch = await extractEntry(o.sessionId, entry, state, o.apiKey, config, o.setup, signal);
      if (!state.facts.length) patch.actors.unshift(...o.pcs);
      signal.throwIfAborted();
      const { error } = await supabase.rpc('save_knowledge_event', {
        target_session: o.sessionId, target_message: entry.id, expected_hash: entry.source_hash,
        desired: patch, setup_hash: hash, expected_revision: o.revision,
      });
      if (error) throw error;
      state = applyPatch(state, patch);
    }
    return { config, state };
  });
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
