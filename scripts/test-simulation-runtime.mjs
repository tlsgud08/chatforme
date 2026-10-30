import assert from "node:assert/strict";
import { createServer } from "vite";
const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
});
const oldFetch = globalThis.fetch;
globalThis.window = { location: { origin: "https://simulation.test" } };
const requests = [],
  costs = [],
  storedRolls = new Map();
let probability = 0.98,
  missingEvidence = false;
const patchSources = {
  id: "m1",
  content: "PC가 창고를 파괴했다. 경비원은 폭발만 보았다.",
  user_text: "창고를 파괴하려 한다.",
  turn_index: 1,
  content_version: 0,
  source_hash: "hash",
  patch: null,
};
const reply = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
globalThis.fetch = async (url, options = {}) => {
  const u = String(url),
    body = options.body ? JSON.parse(options.body) : null;
  requests.push({ u, body });
  if (u.includes("openrouter.ai/api/v1/chat/completions")) {
    const stage = body.response_format.json_schema.name;
    let result;
    if (stage === "simulation_dice")
      result = {
        actions: [
          {
            action: "공격",
            actor: "PC",
            target: "경비원",
            skill: "신체",
            modifier: 0,
          },
        ],
      };
    else
      result = {
        actors: [
          { name: "PC", aliases: [], pc: true },
          { name: "경비원", aliases: [], pc: false },
        ],
        facts: [
          {
            key: "N1",
            kind: "event",
            text: "PC가 창고를 파괴함",
            secret: true,
            subjects: ["PC"],
            source: "assistant",
            quote: "PC가 창고를 파괴했다.",
          },
        ],
        knowledge: [
          {
            fact: "N1",
            actor: "경비원",
            status: "knows",
            reason: "범행 목격",
            source: "assistant",
            quote: missingEvidence
              ? "존재하지 않는 인용"
              : "경비원은 폭발만 보았다.",
            informer: "",
          },
        ],
        scene: ["PC", "경비원"],
      };
    return reply({
      choices: [
        { message: { content: JSON.stringify(result) }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 },
    });
  }
  if (u.includes("/api/alpha/decisions")) {
    assert(body.state.policy);
    assert(Object.values(body.questions).every((q) => q.type === "noul"));
    return reply({
      answers: Object.fromEntries(
        Object.keys(body.questions).map((k) => [
          k,
          { type: "noul", noul: probability },
        ]),
      ),
      usage: { input_tokens: 30, output_tokens: 1, cost: 0.00001 },
    });
  }
  if (u.includes("/platform_config")) return reply({ simulation_prompts: {} });
  if (u.includes("/work_simulation_config")) return reply(null);
  if (u.includes("/session_simulation_rolls")) {
    const key = new URL(u).searchParams.get("scope")?.slice(3);
    return reply(storedRolls.has(key) ? { rolls: storedRolls.get(key) } : null);
  }
  if (u.includes("/rpc/simulation_lease")) return reply(true);
  if (u.includes("/rpc/record_simulation_call")) {
    costs.push(body);
    return reply(null);
  }
  if (u.includes("/rpc/roll_simulation_dice")) {
    const rolls = body.actions.map((a) => ({
      ...a,
      value: 6,
      outcome: "critical_success",
    }));
    storedRolls.set(body.scope_key, rolls);
    return reply(rolls);
  }
  if (u.includes("/rpc/simulation_context"))
    return reply({
      entries: [patchSources],
      settings: { knowledge: true },
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  if (u.includes("/rpc/save_simulation_event")) {
    assert.equal(body.expected_hash, "hash");
    patchSources.patch = body.desired;
    return reply(true);
  }
  throw new Error("Unexpected request " + u);
};
try {
  const r = await server.ssrLoadModule("/src/lib/simulation/runtime.ts");
  const c = await server.ssrLoadModule("/src/lib/simulation/core.ts");
  const { DEFAULT_PROMPTS } = await server.ssrLoadModule(
    "/src/lib/simulation/types.ts",
  );
  const signal = new AbortController().signal;
  const options = {
    sessionId: "room",
    workId: "work",
    settings: { dice: true },
    apiKey: "fixture-key",
    signal,
    beforeTurn: 2,
    input: "경비원을 공격한다",
    recent: "경비원이 앞을 막고 있다.",
    setup: "",
    rollScope: "attempt",
  };
  const prepared = await r.prepareSimulation(options);
  assert.equal(prepared.rolls[0].value, 6);
  const count = requests.filter((q) => q.u.includes("openrouter.ai")).length;
  assert.deepEqual((await r.prepareSimulation(options)).rolls, prepared.rolls);
  assert.equal(
    requests.filter((q) => q.u.includes("openrouter.ai")).length,
    count,
    "same attempt uses stored roll and avoids a paid analysis",
  );
  await r.prepareSimulation({ ...options, input: "다른 대상에게 공격한다" });
  assert.equal(
    requests.filter((q) => q.u.includes("openrouter.ai")).length,
    count + 1,
    "edited input cannot reuse a different action roll",
  );
  assert(
    !requests.some((q) => q.u.includes("/rpc/simulation_context")),
    "dice-only does not load the information ledger",
  );
  const base = {
    systemParts: {
      core: "CORE",
      persona: "",
      userNote: "",
      summary: "",
      keywords: "",
    },
    messages: [{ role: "user", content: "INPUT" }],
  };
  const enriched = r.applySimulation(base, prepared, "공격");
  assert(enriched.systemParts.keywords.includes("critical_success"));
  assert(!enriched.systemParts.core.includes(DEFAULT_PROMPTS.knowledge));
  assert.equal(base.systemParts.core, "CORE");
  probability = 0.12;
  let patch = await r.extractEntry(
    "room",
    patchSources,
    c.emptyState(),
    "fixture-key",
    DEFAULT_PROMPTS,
    "",
    signal,
  );
  assert.equal(patch.facts.length, 1);
  assert.equal(
    patch.knowledge.length,
    0,
    "a witness to the explosion must not automatically learn the culprit",
  );
  missingEvidence = true;
  const before = requests.filter((q) => q.u.includes("decisions")).length;
  patch = await r.extractEntry(
    "room",
    patchSources,
    c.emptyState(),
    "fixture-key",
    DEFAULT_PROMPTS,
    "",
    signal,
  );
  assert.equal(patch.knowledge.length, 0);
  assert.equal(
    requests.filter((q) => q.u.includes("decisions")).length,
    before,
    "invented quotes are rejected before paid verification",
  );
  missingEvidence = false;
  probability = 0.98;
  patch = await r.extractEntry(
    "room",
    patchSources,
    c.emptyState(),
    "fixture-key",
    DEFAULT_PROMPTS,
    "",
    signal,
  );
  assert.equal(patch.knowledge.length, 1);
  assert.equal(patch.knowledge[0].quote, "경비원은 폭발만 보았다.");
  await r.finishSimulation(
    "room",
    "m1",
    { ...prepared, settings: { knowledge: true } },
    "fixture-key",
    signal,
  );
  assert(patchSources.patch);
  assert(costs.every((c) => c.model_name && c.call_cost >= 0));
  assert(
    !JSON.stringify(costs).includes("fixture-key"),
    "API keys never enter persistence",
  );
  console.log(
    "Simulation runtime: actual structured/Decisions HTTP contracts, independent execution, cached roll reuse, evidence rejection, uncertain O rejection, bounded context, completion persistence and separate usage accounting passed (mocked paid APIs).",
  );
} finally {
  globalThis.fetch = oldFetch;
  delete globalThis.window;
  await server.close();
}
