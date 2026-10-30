import assert from "node:assert/strict";
import { createServer } from "vite";
const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const c = await server.ssrLoadModule("/src/lib/simulation/core.ts");
  const { DEFAULT_RULES, DEFAULT_PROMPTS } = await server.ssrLoadModule(
    "/src/lib/simulation/types.ts",
  );
  const { buildOpenRouterMessages } = await server.ssrLoadModule(
    "/src/lib/llm/promptCache.ts",
  );
  const theme = await server.ssrLoadModule("/src/lib/themeDirectives.ts");
  const { stripSyncDateTags } = await server.ssrLoadModule(
    "/src/lib/syncDate.ts",
  );
  const base = {
    systemParts: {
      core: "CORE",
      persona: "PERSONA",
      userNote: "NOTE",
      summary: "SUMMARY",
      storyNotes: "STORY",
      keywords: "KEYWORDS",
    },
    messages: [
      { role: "assistant", content: "HISTORY", cacheBreakpoint: true },
      { role: "user", content: "INPUT" },
    ],
  };
  for (const settings of [undefined, {}, { dice: false, knowledge: false }])
    assert.equal(
      c.extendSimulationPrompt(base, settings, null, "SHOULD NOT APPEAR"),
      base,
    );
  const knowledge = c.extendSimulationPrompt(
    base,
    { knowledge: true },
    DEFAULT_PROMPTS,
    "F1 secret",
  );
  assert(knowledge.systemParts.core.includes(DEFAULT_PROMPTS.knowledge));
  assert(!knowledge.systemParts.core.includes(DEFAULT_PROMPTS.dice));
  const wire = buildOpenRouterMessages({
    ...knowledge,
    model: "fixture",
    cacheSystemOnly: true,
  });
  assert(!JSON.stringify(wire[0]).includes("F1 secret"));
  assert(wire.at(-1).content.includes("F1 secret"));
  assert.equal(wire[1].content, "HISTORY");
  const input = {
    action: "攻撃",
    actor: "PC",
    target: "NPC",
    skill: "신체",
    modifier: 0,
  };
  assert.equal(c.actionThresholds(input).successMin, 5);
  assert.equal(
    c.actionThresholds(
      { ...input, modifier: 2 },
      { ...DEFAULT_RULES, criticalMin: 7 },
    ).criticalMin,
    7,
    "disabled criticals remain disabled even with advantage",
  );
  assert.equal(
    c.actionThresholds(input, {
      ...DEFAULT_RULES,
      actors: { PC: { 신체: 6 }, NPC: { 신체: 0 } },
    }).successMin,
    3,
  );
  assert.throws(() => c.validateRules({ ...DEFAULT_RULES, die: 0 }));
  assert.throws(() => c.validateRules({ ...DEFAULT_RULES, criticalMin: 4 }));
  assert.throws(() => c.actionThresholds({ ...input, modifier: 3 }));
  const patch = {
    actors: [
      { name: "PC", pc: true, aliases: [] },
      { name: "리아", pc: false, aliases: [] },
    ],
    facts: [
      {
        id: "f1",
        kind: "event",
        text: "PC가 창고를 파괴함",
        secret: true,
        subjects: ["PC"],
      },
    ],
    knowledge: [
      { fact: "f1", actor: "PC", status: "knows", reason: "직접 실행" },
    ],
    scene: ["PC", "리아"],
  };
  let state = c.applyPatch(c.emptyState(), patch);
  state = c.applyPatch(state, {
    actors: [],
    facts: [],
    knowledge: [],
    scene: ["PC"],
  });
  assert.equal(
    state.actors.length,
    2,
    "absent, dead or hostile actors are not removed",
  );
  assert(c.knowledgeBlock(state, "리아를 만난다").includes("인지:PC"));
  assert(
    !c.knowledgeBlock(state, "리아를 만난다").includes("직접 실행"),
    "full reasons stay in storage",
  );
  state = c.applyPatch(state, {
    actors: [],
    facts: [],
    knowledge: [{ fact: "f1", actor: "PC", status: "unknown" }],
    scene: ["PC"],
  });
  assert.equal(
    state.knowledge.length,
    0,
    "explicit user X correction overrides known state",
  );
  const catalog = [
    {
      id: "night",
      name: "밤거리",
      work_id: "work",
      owner_id: "owner",
      day_night_enabled: false,
      colors: {},
      light_colors: null,
    },
    {
      id: "room",
      name: "실내",
      work_id: "work",
      owner_id: "owner",
      day_night_enabled: false,
      colors: {},
      light_colors: null,
    },
  ];
  for (const text of [
    "{{theme::밤거리}}이야기{{sync_date::날짜}}",
    "이야기{{sync_date::날짜}}{{theme::밤거리}}다음",
    "{{sync_date::날짜}}앞{{theme::밤거리}}중간",
  ]) {
    assert.equal(theme.finalValidThemeDirective(text, catalog), "밤거리");
    assert(!stripSyncDateTags(theme.stripThemeDirectives(text)).includes("{{"));
  }
  assert.equal(
    theme.finalValidThemeDirective(
      "{{theme::밤거리}} x {{theme::실내}} y {{theme::없는테마}}",
      catalog,
    ),
    "실내",
  );
  assert.equal(
    theme.finalValidThemeDirective(
      "{{theme::밤거리}}{{theme::keep}}text",
      catalog,
    ),
    "keep",
  );
  for (const text of [
    "{{theme::밤거리}}{{sync_date::날짜}}",
    "{{sync_date::날짜}}{{theme::밤거리}}",
  ])
    for (let i = 1; i <= text.length; i++)
      assert(
        !stripSyncDateTags(
          theme.stripThemeDirectives(text.slice(0, i), true),
          true,
        ).includes("{{"),
        "partial mixed directives never flash",
      );
  console.log(
    "Simulation core: independent prompts, exact OFF identity, dynamic state outside cached prefix, validated numeric rules, knowledge retention/correction and position-independent mixed tags passed.",
  );
} finally {
  await server.close();
}
