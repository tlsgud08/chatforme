import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite(),
  dir = new URL("../supabase/migrations/", import.meta.url);
const a = "00000000-0000-0000-0000-000000000001",
  b = "00000000-0000-0000-0000-000000000002",
  work = "10000000-0000-0000-0000-000000000001",
  room = "20000000-0000-0000-0000-000000000001";
const q = async (s, p = []) => (await db.query(s, p)).rows;
const rpc = async (n, p = []) =>
  (
    await q(
      `select public.${n}(${p.map((_, i) => "$" + (i + 1)).join(",")}) value`,
      p,
    )
  )[0].value;
const login = async (id) => {
  await db.exec("reset role");
  await q("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ""]);
  await db.exec(id ? "set role authenticated" : "set role anon");
};
try {
  await db.exec(`create role authenticated;create role anon;create role service_role;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.email() returns text language sql stable as $$select 'fixture@example.test'::text$$;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');`);
  for (const file of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    if (file.startsWith("0012_") || file.startsWith("0032_")) continue;
    let source = readFileSync(new URL(file, dir), "utf8");
    if (file.startsWith("0003_follows") || file.startsWith("0008_"))
      source = source.split("insert into storage.buckets")[0];
    source = source
      .replace(/create extension if not exists pgcrypto;/gi, "")
      .replace(/do \$\$ begin alter publication[\s\S]*?end \$\$;/gi, "");
    try {
      await db.exec(source);
    } catch (e) {
      throw new Error(file + ": " + e.message);
    }
  }
  await db.exec(`grant usage on schema public,auth to authenticated,anon;grant select on all tables in schema public to authenticated;grant select,insert,update,delete on public.works,public.sessions,public.messages to authenticated;grant select,update on public.platform_config to authenticated;
 insert into auth.users(id,email) values('${a}','topshjtv@gmail.com'),('${b}','outsider@test');
 create or replace function auth.email() returns text language sql stable as $$select email from auth.users where id=auth.uid()$$;
 grant select on auth.users to authenticated;
 insert into works(id,creator_id,title,visibility) values('${work}','${a}','Simulation fixture','private');
 insert into sessions(id,user_id,work_id) values('${room}','${a}','${work}');
 create schema if not exists extensions;
 create sequence extensions.test_rng;
 -- Test-only source: first sample is deliberately rejected, second sample is 5.
 create function extensions.gen_random_bytes(integer) returns bytea language plpgsql as $$declare n bigint;begin n:=nextval('extensions.test_rng');return decode(case when n=1 then 'ffffffff' when n=2 then '00000005' else lpad(to_hex(n%256),8,'0') end,'hex');end$$;`);
  await login(a);
  assert.deepEqual(
    (await q("select simulation_settings from sessions where id=$1", [room]))[0]
      .simulation_settings,
    {},
  );
  await assert.rejects(() =>
    rpc("roll_simulation_dice", [room, "disabled", []]),
  );
  const on = { dice: true, knowledge: true, knowledgeFromTurn: 0 };
  assert.deepEqual(await rpc("set_simulation_settings", [room, {}, on]), on);
  await assert.rejects(() =>
    rpc("set_simulation_settings", [
      room,
      {},
      { dice: false, knowledge: false },
    ]),
  );
  await assert.rejects(() => rpc("roll_simulation_dice", [room, "bad", [{}]]));
  await assert.rejects(() =>
    rpc("roll_simulation_dice", [
      room,
      "bad",
      [{ die: 6, successMin: 8, criticalMin: 6 }],
    ]),
  );
  const actions = [
    {
      actor: "PC",
      target: "NPC",
      action: "공격",
      skill: "신체",
      modifier: 0,
      die: 6,
      successMin: 5,
      criticalMin: 6,
    },
  ];
  const rolls = await rpc("roll_simulation_dice", [room, "attempt1", actions]);
  assert.equal(rolls[0].value, 6);
  assert.equal(rolls[0].outcome, "critical_success");
  await db.exec("reset role");
  const sequence = (await q("select last_value from extensions.test_rng"))[0]
    .last_value;
  await login(a);
  assert.deepEqual(
    await rpc("roll_simulation_dice", [room, "attempt1", []]),
    rolls,
  );
  await db.exec("reset role");
  assert.equal(
    (await q("select last_value from extensions.test_rng"))[0].last_value,
    sequence,
    "retries never reroll",
  );
  await login(a);
  const first = (
    await q(
      "insert into messages(session_id,role,content,turn_index) values($1,'assistant','PC는 도서관에 갔다.',0) returning *",
      [room],
    )
  )[0];
  const context = await rpc("simulation_context", [room]);
  assert.equal(context.entries.length, 1);
  const hash = await rpc("simulation_source_hash", [room, 0]);
  assert.equal(hash, context.entries[0].source_hash);
  const patch = {
    actors: [{ name: "PC", pc: true, aliases: [] }],
    facts: [
      {
        id: "f1",
        kind: "event",
        text: "PC가 도서관에 감",
        secret: false,
        subjects: ["PC"],
      },
    ],
    knowledge: [
      {
        fact: "f1",
        actor: "PC",
        status: "knows",
        reason: "직접 방문",
        source: first.id,
        quote: "도서관에 갔다",
      },
    ],
    scene: ["PC"],
  };
  assert.equal(
    await rpc("save_simulation_event", [room, first.id, hash, patch]),
    true,
  );
  assert.deepEqual(
    (await rpc("simulation_context", [room])).entries[0].patch,
    patch,
  );
  await assert.rejects(() =>
    q(
      "insert into session_simulation_events(session_id,message_id,source_hash,patch) values($1,$2,$3,$4)",
      [room, first.id, hash, JSON.stringify(patch)],
    ),
  );
  await rpc("record_simulation_call", [
    room,
    "30000000-0000-0000-0000-000000000001",
    "knowledge",
    "fixture",
    12,
    3,
    0.001,
  ]);
  await rpc("record_simulation_call", [
    room,
    "30000000-0000-0000-0000-000000000001",
    "knowledge",
    "fixture",
    12,
    3,
    0.001,
  ]);
  assert.equal((await rpc("simulation_context", [room])).cost, 0.001);
  await login(b);
  await assert.rejects(() => rpc("simulation_context", [room]));
  await assert.rejects(() =>
    rpc("roll_simulation_dice", [room, "attempt1", actions]),
  );
  await assert.rejects(() =>
    rpc("save_simulation_event", [room, first.id, hash, patch]),
  );
  await assert.rejects(() =>
    rpc("record_simulation_call", [
      room,
      "30000000-0000-0000-0000-000000000002",
      "dice",
      "fixture",
      1,
      1,
      0,
    ]),
  );
  await assert.rejects(() =>
    rpc("save_simulation_prompts", [
      {},
      { dice: "d", knowledge: "k", analystModel: "m", verifierModel: "v" },
    ]),
  );
  await login(null);
  await assert.rejects(() => rpc("simulation_context", [room]));
  await assert.rejects(() =>
    rpc("roll_simulation_dice", [room, "anon", actions]),
  );
  await login(a);
  assert.equal(
    await rpc("save_simulation_prompts", [
      {},
      { dice: "d", knowledge: "k", analystModel: "m", verifierModel: "v" },
    ]),
    true,
  );
  assert.equal(
    await rpc("save_work_simulation", [work, {}, { dicePrompt: "WORK DICE" }]),
    true,
  );
  await assert.rejects(() =>
    rpc("save_work_simulation", [work, {}, { dicePrompt: "STALE" }]),
  );
  const token = "40000000-0000-0000-0000-000000000001",
    otherToken = "40000000-0000-0000-0000-000000000002";
  assert.equal(await rpc("simulation_lease", [room, token, "claim"]), true);
  assert.equal(
    await rpc("simulation_lease", [room, otherToken, "claim"]),
    false,
  );
  assert.equal(await rpc("simulation_lease", [room, token, "renew"]), true);
  await assert.rejects(() =>
    rpc("set_simulation_settings", [
      room,
      on,
      { dice: false, knowledge: false },
    ]),
  );
  await rpc("simulation_lease", [room, token, "release"]);
  assert.equal(
    await rpc("simulation_lease", [room, otherToken, "claim"]),
    true,
  );
  await rpc("simulation_lease", [room, otherToken, "release"]);
  const second = (
    await q(
      "insert into messages(session_id,role,content,turn_index) values($1,'assistant','다음 장면',1) returning *",
      [room],
    )
  )[0];
  const hash2 = await rpc("simulation_source_hash", [room, 1]);
  await rpc("save_simulation_event", [
    room,
    second.id,
    hash2,
    { actors: [], facts: [], knowledge: [], scene: ["PC"] },
  ]);
  const corrected = { ...patch, knowledge: [] };
  await rpc("save_simulation_event", [room, first.id, hash, corrected, patch]);
  assert.equal(
    (await rpc("simulation_context", [room])).entries[1].patch,
    null,
    "manual correction invalidates dependent derived state",
  );
  await assert.rejects(
    () => rpc("save_simulation_event", [room, first.id, hash, patch, patch]),
    "stale manual correction cannot overwrite",
  );
  await q("update messages set content='수정한 장면' where id=$1", [first.id]);
  assert.equal(
    (await rpc("simulation_context", [room])).entries[0].patch,
    null,
    "source revision invalidates old knowledge",
  );
  await assert.rejects(() =>
    rpc("save_simulation_event", [room, first.id, hash, patch]),
  );
  await rpc("set_simulation_settings", [
    room,
    on,
    { dice: false, knowledge: false, knowledgeFromTurn: 0 },
  ]);
  await assert.rejects(() =>
    rpc("roll_simulation_dice", [room, "off", actions]),
  );
  console.log(
    "Simulation DB: default OFF, independent settings/CAS, authorization, immutable retry rolls, rejection sampling, source hashes, stale edits, manual correction invalidation, admin/work prompt saves and idempotent costs passed.",
  );
} finally {
  await db.close();
}
