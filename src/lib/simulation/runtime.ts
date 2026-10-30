import { supabase } from "../supabase";
import { stripThemeDirectives } from "../themeDirectives";
import { stripSyncDateTags } from "../syncDate";
import type { AssembledPrompt } from "../prompt/assemble";
import {
  actionThresholds,
  applyPatch,
  emptyState,
  extendSimulationPrompt,
  knowledgeBlock,
  selectFacts,
  validateRules,
} from "./core";
import { structured, verify } from "./models";
import {
  DEFAULT_PROMPTS,
  DEFAULT_WORK,
  simulationEnabled,
  type Action,
  type Actor,
  type Fact,
  type Knowledge,
  type KnowledgePatch,
  type KnowledgeState,
  type Roll,
  type SimulationContext,
  type SimulationEntry,
  type SimulationPrompts,
  type SimulationSettings,
  type WorkSimulation,
} from "./types";

const textSchema = { type: "string" },
  boolSchema = { type: "boolean" };
const array = (items: unknown) => ({ type: "array", items });
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const actionSchema = object({
  actions: array(
    object({
      action: textSchema,
      actor: textSchema,
      target: textSchema,
      skill: textSchema,
      modifier: { type: "integer" },
    }),
  ),
});
interface Extraction {
  actors: Actor[];
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
    object({ name: textSchema, aliases: array(textSchema), pc: boolSchema }),
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
      status: { type: "string", enum: ["knows", "suspects", "believes"] },
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
    const { data, error } = await supabase.rpc("simulation_lease", {
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
export async function loadSimulationPrompts(
  signal?: AbortSignal,
): Promise<{ raw: Partial<SimulationPrompts>; value: SimulationPrompts }> {
  let q = supabase
    .from("platform_config")
    .select("simulation_prompts")
    .eq("id", 1);
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q.single();
  if (error || !data)
    throw error ?? new Error("전역 판정·정보 프롬프트 조회 실패");
  const raw = data.simulation_prompts as Partial<SimulationPrompts>;
  return { raw, value: { ...DEFAULT_PROMPTS, ...raw } };
}
export async function loadWorkSimulation(
  workId: string,
  signal?: AbortSignal,
): Promise<{ raw: Partial<WorkSimulation>; value: WorkSimulation }> {
  let q = supabase
    .from("work_simulation_config")
    .select("settings")
    .eq("work_id", workId);
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  const raw = (data?.settings ?? {}) as Partial<WorkSimulation>;
  const value = { ...DEFAULT_WORK, ...raw };
  validateRules(value.rules);
  return { raw, value };
}
export async function readSimulationContext(
  sessionId: string,
  beforeTurn?: number,
): Promise<SimulationContext> {
  const { data, error } = await supabase.rpc("simulation_context", {
    target_session: sessionId,
    ...(beforeTurn != null && { before_turn: beforeTurn }),
  });
  if (error || !data) throw error ?? new Error("정보 기록 조회 실패");
  return data as SimulationContext;
}
export function replayContext(context: SimulationContext): {
  state: KnowledgeState;
  pending: SimulationEntry[];
} {
  let state = emptyState(),
    stale = false;
  const pending: SimulationEntry[] = [];
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
  entry: SimulationEntry,
  state: KnowledgeState,
  apiKey: string,
  prompts: SimulationPrompts,
  setup: string,
  signal: AbortSignal,
): Promise<KnowledgePatch> {
  let interim = state;
  const finalPatch = emptyState();
  const userParts = chunks(cleanNarrative(entry.user_text)),
    assistantParts = chunks(cleanNarrative(entry.content));
  // Never truncate a long source silently: process separate bounded fragments.
  const fragments = [
    ...(!state.facts.length
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
  ];
  for (let index = 0; index < fragments.length; index++) {
    signal.throwIfAborted();
    const sources = fragments[index];
    const relevant = selectFacts(
      interim,
      [sources.user, sources.assistant].join("\n"),
    );
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
      { apiKey, sessionId, model: prompts.analystModel, signal },
      "knowledge",
      prompts.knowledge +
        "\nReturn JSON changes only. facts.key uses N1,N2... for new facts; knowledge.fact references an existing F# or a new N#. All evidence quotes must be exact substrings of the indicated user/assistant/setup source. Do not register every name in setup: only PCs and characters encountered in the actual scene or INFO. Keep every registered actor, including absent/dead/hostile actors. Return current scene names; do not treat every INFO entry as physically present. No deletion. Setup can establish a character knowing their own identity only when explicitly supported. Do not make intentions into completed events. User action text alone does not prove a successful event: require the assistant result for completed outcomes. Maximum 12 facts and 24 knowledge candidates per fragment.",
      { sources, actors: interim.actors, existing, scene: interim.scene },
      extractionSchema,
      3000,
    );
    if (
      !Array.isArray(output.actors) ||
      !Array.isArray(output.facts) ||
      !Array.isArray(output.knowledge) ||
      !strings(output.scene)
    )
      throw new Error("정보 추출 형식이 올바르지 않습니다.");
    if (
      output.actors.length > 30 ||
      output.facts.length > 12 ||
      output.knowledge.length > 24
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
        v.aliases.includes(a.name),
      );
      const old =
        validActors.get(a.name) ??
        (aliasMatches.length === 1 ? aliasMatches[0] : undefined);
      const actor = old
        ? { ...old, aliases: [...new Set([...old.aliases, ...a.aliases])] }
        : a;
      validActors.set(actor.name, actor);
      patch.actors.push(actor);
    }
    const factMap = new Map<string, Fact>(Object.entries(references));
    const evidence = (source: string, quote: string) =>
      ["user", "assistant", "setup"].includes(source) &&
      bounded(quote, 800) &&
      (sources[source as keyof typeof sources] || "").includes(quote);
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
    const candidates: { knowledge: Knowledge; context: unknown }[] = [];
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
        !["knows", "suspects", "believes"].includes(k.status)
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
      if (k.status === "knows")
        candidates.push({
          knowledge,
          context: {
            fact: fact.text,
            actor: actor.name,
            reason: k.reason,
            quote: k.quote,
            source: k.source,
            passage: (() => {
              const passage = sources[k.source as keyof typeof sources],
                at = passage.indexOf(k.quote);
              return passage.slice(
                Math.max(0, at - 500),
                at + k.quote.length + 500,
              );
            })(),
            existing_knowers: interim.knowledge
              .filter((v) => v.fact === fact.id && v.status === "knows")
              .map((v) => v.actor),
            informer: k.informer,
          },
        });
      else patch.knowledge.push(knowledge);
    }
    if (candidates.length) {
      const approved = await verify(
        { apiKey, sessionId, model: prompts.verifierModel, signal },
        prompts.knowledge,
        candidates.map((c) => c.context),
      );
      candidates.forEach((c, i) => {
        if (approved[i]) patch.knowledge.push(c.knowledge);
      });
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

export interface PrepareSimulationOptions {
  sessionId: string;
  workId: string;
  settings: SimulationSettings;
  apiKey: string;
  signal: AbortSignal;
  beforeTurn: number;
  input: string;
  recent?: string;
  setup: string;
  rollScope: string;
}
export interface PreparedSimulation {
  settings: SimulationSettings;
  prompts: SimulationPrompts;
  work: WorkSimulation;
  state: KnowledgeState;
  rolls: Roll[];
  setup: string;
}
export async function prepareSimulation(
  o: PrepareSimulationOptions,
): Promise<PreparedSimulation> {
  if (!simulationEnabled(o.settings))
    throw new Error("꺼진 기능의 준비 요청입니다.");
  const [prompts, work] = await Promise.all([
    loadSimulationPrompts(o.signal),
    loadWorkSimulation(o.workId, o.signal),
  ]);
  let state = emptyState();
  if (o.settings.knowledge) {
    state = await withKnowledgeLease(o.sessionId, o.signal, async (signal) => {
      const context = await readSimulationContext(o.sessionId, o.beforeTurn),
        replay = replayContext(context);
      state = replay.state;
      for (const entry of replay.pending) {
        const patch = await extractEntry(
          o.sessionId,
          entry,
          state,
          o.apiKey,
          prompts.value,
          [o.setup, work.value.knowledgePrompt].filter(Boolean).join("\n"),
          signal,
        );
        signal.throwIfAborted();
        const { error } = await supabase.rpc("save_simulation_event", {
          target_session: o.sessionId,
          target_message: entry.id,
          expected_hash: entry.source_hash,
          desired: patch,
        });
        if (error) throw error;
        state = applyPatch(state, patch);
      }
      return state;
    });
  }
  let rolls: Roll[] = [];
  if (o.settings.dice) {
    // Stable retries reuse their result, but edited actions, context or rules
    // must never inherit a roll for a different action.
    const content = JSON.stringify([
      o.input,
      o.recent ?? "",
      work.value,
      selectFacts(state, o.input),
    ]);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(content),
    );
    const fingerprint = Array.from(new Uint8Array(digest))
      .slice(0, 16)
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    const rollScope = `${o.rollScope}:${fingerprint}`;
    const cached = await supabase
      .from("session_simulation_rolls")
      .select("rolls")
      .eq("session_id", o.sessionId)
      .eq("scope", rollScope)
      .maybeSingle();
    if (cached.error) throw cached.error;
    if (cached.data) rolls = cached.data.rolls as Roll[];
    else {
      const plan = await structured<{ actions: Action[] }>(
        {
          apiKey: o.apiKey,
          sessionId: o.sessionId,
          model: prompts.value.analystModel,
          signal: o.signal,
        },
        "dice",
        prompts.value.dice +
          "\n" +
          work.value.dicePrompt +
          "\nReturn actions only, maximum 4, using the configured skill names and actual actor names or PC. Ordinary dialogue has actions:[]. Modifier is an integer -2..2 for circumstances only. No completed outcomes. Do not turn physically impossible actions into successful rolls.",
        {
          input: o.input,
          recent: o.recent ?? "",
          scene: state.scene,
          rules: work.value.rules,
          context: selectFacts(state, o.input).map((f) => f.text),
        },
        actionSchema,
        900,
      );
      if (!Array.isArray(plan.actions) || plan.actions.length > 4)
        throw new Error("판정 행동 목록을 확인하지 못했습니다.");
      const thresholds = plan.actions.map((a) =>
        actionThresholds(a, work.value.rules),
      );
      const { data, error } = await supabase.rpc("roll_simulation_dice", {
        target_session: o.sessionId,
        scope_key: rollScope,
        actions: thresholds,
      });
      if (error) throw error;
      rolls = data as Roll[];
    }
  }
  return {
    settings: o.settings,
    prompts: prompts.value,
    work: work.value,
    state,
    rolls,
    setup: [o.setup, work.value.knowledgePrompt].filter(Boolean).join("\n"),
  };
}
export function applySimulation(
  base: AssembledPrompt,
  p: PreparedSimulation,
  input: string,
) {
  return extendSimulationPrompt(
    base,
    p.settings,
    p.prompts,
    p.settings.knowledge ? knowledgeBlock(p.state, input) : "",
    p.rolls,
  );
}
export async function finishSimulation(
  sessionId: string,
  messageId: string,
  p: PreparedSimulation,
  apiKey: string,
  signal: AbortSignal,
) {
  if (!p.settings.knowledge) return;
  return withKnowledgeLease(sessionId, signal, async (signal) => {
    const context = await readSimulationContext(sessionId),
      row = context.entries.find((e) => e.id === messageId);
    if (!row) throw new Error("완성된 답변의 정보 기록을 확인하지 못했습니다.");
    if (row.patch) return;
    // Replay/recover all pending rows before this one; do not use a stale pre-call snapshot.
    const replay = replayContext({
      ...context,
      entries: context.entries.filter((e) => e.turn_index <= row.turn_index),
    });
    let state = replay.state;
    for (const entry of replay.pending) {
      const patch = await extractEntry(
        sessionId,
        entry,
        state,
        apiKey,
        p.prompts,
        p.setup,
        signal,
      );
      signal.throwIfAborted();
      const { error } = await supabase.rpc("save_simulation_event", {
        target_session: sessionId,
        target_message: entry.id,
        expected_hash: entry.source_hash,
        desired: patch,
      });
      if (error) throw error;
      state = applyPatch(state, patch);
    }
  });
}
