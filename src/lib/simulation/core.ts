import type { AssembledPrompt } from "../prompt/assemble";
import {
  DEFAULT_RULES,
  type Action,
  type Actor,
  type DiceRules,
  type Fact,
  type KnowledgePatch,
  type KnowledgeState,
  type Roll,
  type SimulationPrompts,
  type SimulationSettings,
} from "./types";

export const emptyState = (): KnowledgeState => ({
  actors: [],
  facts: [],
  knowledge: [],
  scene: [],
});
const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
export function validateRules(value: unknown): DiceRules {
  const r = value as DiceRules;
  if (
    !r ||
    !integer(r.die, 2, 10000) ||
    !integer(r.successMin, 1, r.die + 1) ||
    !integer(r.criticalMin, r.successMin, r.die + 1) ||
    !integer(r.statStep, 1, 10000) ||
    !Array.isArray(r.skills) ||
    !r.skills.length ||
    r.skills.length > 30 ||
    r.skills.some((s) => typeof s !== "string" || !s.trim() || s.length > 60) ||
    !r.actors ||
    typeof r.actors !== "object" ||
    Array.isArray(r.actors)
  )
    throw new Error("주사위 규칙의 범위·능력 목록을 확인해 주세요.");
  for (const [name, stats] of Object.entries(r.actors)) {
    if (
      !name.trim() ||
      name.length > 100 ||
      !stats ||
      typeof stats !== "object" ||
      Array.isArray(stats) ||
      Object.entries(stats).some(
        ([k, v]) => !r.skills.includes(k) || !integer(v, -10000, 10000),
      )
    )
      throw new Error("인물 능력치는 등록된 능력의 정수로 입력해 주세요.");
  }
  return r;
}
export function actionThresholds(a: Action, rules = DEFAULT_RULES) {
  if (
    !a ||
    typeof a.action !== "string" ||
    !a.action.trim() ||
    a.action.length > 300 ||
    typeof a.actor !== "string" ||
    !a.actor.trim() ||
    typeof a.target !== "string" ||
    !rules.skills.includes(a.skill) ||
    !integer(a.modifier, -2, 2)
  )
    throw new Error("판정 요청의 행동·능력·보정이 올바르지 않습니다.");
  const difference =
    (rules.actors[a.actor]?.[a.skill] ?? 0) -
    (rules.actors[a.target]?.[a.skill] ?? 0);
  const advantage = Math.trunc(difference / rules.statStep) + a.modifier;
  const clamp = (n: number) => Math.max(1, Math.min(rules.die + 1, n));
  return {
    ...a,
    die: rules.die,
    successMin: clamp(rules.successMin - advantage),
    criticalMin:
      rules.criticalMin > rules.die
        ? rules.die + 1
        : clamp(rules.criticalMin - advantage),
  };
}
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
  const knowledge = new Map(
    state.knowledge.map((k) => [`${k.fact}\u0000${k.actor}`, k]),
  );
  for (const k of patch.knowledge) {
    if (!actors.has(k.actor) || !facts.has(k.fact)) continue;
    const key = `${k.fact}\u0000${k.actor}`,
      old = knowledge.get(key);
    if (k.status === "unknown") {
      knowledge.delete(key);
      continue;
    }
    if (old?.status !== "knows" || k.status === "knows") knowledge.set(key, k);
  }
  return {
    actors: [...actors.values()],
    facts: [...facts.values()],
    knowledge: [...knowledge.values()],
    scene: patch.scene,
  };
}
const mentions = (text: string, a: Actor) =>
  [a.name, ...a.aliases].some(
    (n) => n && text.toLocaleLowerCase().includes(n.toLocaleLowerCase()),
  );
/** Reasons and the full O/X matrix stay in storage; secrets are never silently evicted. */
export function selectFacts(state: KnowledgeState, input: string): Fact[] {
  const names = new Set(
    state.actors
      .filter((a) => a.pc || state.scene.includes(a.name) || mentions(input, a))
      .map((a) => a.name),
  );
  const relevant = state.facts.filter(
    (f) =>
      f.subjects.some((n) => names.has(n)) ||
      f.text.split(/[\s,.;:]+/).some((w) => w.length >= 3 && input.includes(w)),
  );
  const mandatory = relevant.filter((f) => f.secret),
    optional = relevant.filter((f) => !f.secret);
  const chosen = [...mandatory, ...optional.slice(-16)];
  if (chosen.length < 8)
    for (const f of state.facts.slice(-8))
      if (!chosen.includes(f)) chosen.push(f);
  if (chosen.reduce((n, f) => n + f.text.length, 0) > 12000)
    throw new Error(
      "이번 장면의 필수 정보가 전송 예산을 초과했습니다. 정보 표에서 관련 사실을 정리해 주세요.",
    );
  return chosen;
}
export function knowledgeBlock(state: KnowledgeState, input: string) {
  const facts = selectFacts(state, input);
  const actors = state.actors.filter(
    (a) => a.pc || state.scene.includes(a.name) || mentions(input, a),
  );
  return [
    "[이번 장면의 정보 접근]",
    `등장 인물: ${actors.map((a) => a.name).join(", ") || "아직 확인된 인물 없음"}`,
    "X는 확인된 인지 근거가 없다는 뜻이다. 없는 전달·목격을 발명하지 않는다. 세계 설정·독백·요약을 모든 인물의 지식으로 취급하지 않는다. PC 시점 서술과 NPC 대사는 각자의 지식을 따른다. 실제 전달·목격은 발생 시점부터 반영한다.",
    ...facts.map((f, i) => {
      const aware = state.knowledge.filter((k) => k.fact === f.id);
      return `F${i + 1}: ${f.text}${f.secret ? " [비밀]" : ""} / 인지:${
        aware
          .filter((k) => k.status === "knows")
          .map((k) => k.actor)
          .join(",") || "미확인"
      }${
        aware.some((k) => k.status !== "knows")
          ? " / 추측·믿음:" +
            aware
              .filter((k) => k.status !== "knows")
              .map((k) => `${k.actor}(${k.status})`)
              .join(",")
          : ""
      }`;
    }),
    "기재된 인지자 외의 인물은 이 사실을 이미 아는 것으로 단정하지 않는다. 이 목록은 발췌이며 다른 비밀의 공개를 허가하지 않는다.",
  ].join("\n");
}
/** OFF returns the identical object: no labels, whitespace, history or cache changes. */
export function extendSimulationPrompt(
  base: AssembledPrompt,
  settings: SimulationSettings | undefined,
  prompts: SimulationPrompts | null,
  block = "",
  rolls: Roll[] = [],
): AssembledPrompt {
  if (!settings?.dice && !settings?.knowledge) return base;
  const fixed = [
    settings.dice && prompts?.dice,
    settings.knowledge && prompts?.knowledge,
  ]
    .filter(Boolean)
    .join("\n");
  const dynamic = [
    settings.knowledge && block,
    settings.dice &&
      rolls.length > 0 &&
      "[확정 판정 / 결과를 준수하세요]\n" +
        rolls
          .map(
            (r) =>
              `${r.actor}: ${r.action} → ${r.target || "환경"} / ${r.skill} / d${r.die}=${r.value}; 성공 ${r.successMin} 이상, 대성공 ${r.criticalMin} 이상 → ${r.outcome}`,
          )
          .join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...base,
    systemParts: {
      ...base.systemParts,
      core: [base.systemParts.core, fixed].filter(Boolean).join("\n\n"),
      keywords: [base.systemParts.keywords, dynamic]
        .filter(Boolean)
        .join("\n\n"),
    },
  };
}
