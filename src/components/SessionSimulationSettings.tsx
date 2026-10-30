import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@/types/db";
import type {
  Fact,
  Knowledge,
  KnowledgeState,
  Roll,
  SimulationContext,
  SimulationSettings,
} from "@/lib/simulation/types";
import { supabase } from "@/lib/supabase";
import { readSimulationContext, replayContext } from "@/lib/simulation/runtime";
import Toggle from "./Toggle";

export default function SessionSimulationSettings({
  session,
  busy,
  turn,
  onUpdate,
}: {
  session: Session;
  busy: boolean;
  turn: number;
  onUpdate: (patch: Partial<Session>) => void;
}) {
  const [limit, setLimit] = useState(100),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState(""),
    [context, setContext] = useState<SimulationContext | null>(null),
    [state, setState] = useState<KnowledgeState | null>(null),
    [rolls, setRolls] = useState<Roll[][]>([]),
    [search, setSearch] = useState(""),
    [kind, setKind] = useState("all"),
    [inspect, setInspect] = useState<{
      fact: Fact;
      actor: string;
      value: Knowledge | undefined;
    } | null>(null),
    [reason, setReason] = useState("");
  const lock = useRef(false),
    route = useRef(session.id);
  route.current = session.id;
  const settings = session.simulation_settings ?? {};
  async function refresh() {
    const id = session.id;
    setMessage("");
    try {
      const [next, r] = await Promise.all([
        readSimulationContext(id),
        supabase
          .from("session_simulation_rolls")
          .select("rolls")
          .eq("session_id", id)
          .order("created_at", { ascending: false })
          .limit(12),
      ]);
      if (route.current !== id) return;
      if (r.error) throw r.error;
      setContext(next);
      const replay = replayContext(next);
      setState(replay.state);
      setRolls((r.data ?? []).map((v) => v.rolls as Roll[]));
      if (replay.pending.length)
        setMessage(
          `${replay.pending.length}개 응답의 정보 정리가 필요해요. 다음 생성 전에 이어서 처리해요.`,
        );
    } catch (e) {
      if (route.current === id) setMessage((e as Error).message);
    }
  }
  useEffect(() => {
    setContext(null);
    setState(null);
    setRolls([]);
    setInspect(null);
    if (settings.dice || settings.knowledge) void refresh();
  }, [
    session.id,
    settings.dice,
    settings.knowledge,
    settings.knowledgeFromTurn,
  ]);
  async function save(patch: Partial<SimulationSettings>) {
    if (lock.current || busy) return;
    lock.current = true;
    setSaving(true);
    const desired = {
      ...settings,
      dice: settings.dice ?? false,
      knowledge: settings.knowledge ?? false,
      ...patch,
    };
    try {
      const { data, error } = await supabase.rpc("set_simulation_settings", {
        target_session: session.id,
        previous: settings,
        desired,
      });
      if (error || !data) throw error ?? new Error("저장 실패");
      onUpdate({ simulation_settings: data as SimulationSettings });
      setMessage("기능 설정을 저장했어요.");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  async function correct(known: boolean) {
    if (!inspect || !context || busy || lock.current) return;
    const row = context.entries.at(-1);
    if (!row?.patch || context.entries.some((e) => !e.patch)) {
      setMessage("정보 정리가 끝난 뒤 수정해 주세요.");
      return;
    }
    if (known && !reason.trim()) {
      setMessage("알게 된 경위를 입력해 주세요.");
      return;
    }
    lock.current = true;
    setSaving(true);
    try {
      const relation = {
        fact: inspect.fact.id,
        actor: inspect.actor,
        status: known ? "knows" : "unknown",
        reason: reason.trim(),
        quote: "사용자 직접 정정",
        source: row.id,
      };
      const patch = {
        ...row.patch,
        knowledge: [
          ...row.patch.knowledge.filter(
            (k) => !(k.fact === relation.fact && k.actor === relation.actor),
          ),
          relation,
        ],
      };
      const { error } = await supabase.rpc("save_simulation_event", {
        target_session: session.id,
        target_message: row.id,
        expected_hash: row.source_hash,
        desired: patch,
        expected_previous: row.patch,
      });
      if (error) throw error;
      setInspect(null);
      await refresh();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  const relations = useMemo(
    () =>
      new Map(
        state?.knowledge.map((k) => [`${k.fact}\u0000${k.actor}`, k]) ?? [],
      ),
    [state],
  );
  useEffect(() => setLimit(100), [search, kind]);
  const facts =
    state?.facts.filter(
      (f) =>
        (kind === "all" || f.kind === kind) &&
        (!search ||
          f.text.includes(search) ||
          f.subjects.some((n) => n.includes(search))),
    ) ?? [];
  return (
    <section className="inu-section">
      <h3>주사위 · 정보 관리</h3>
      <label className="inu-switch-row inu-tall">
        <span>
          주사위 판정<small>불확실한 PC 행동을 실제 난수로 판정해요</small>
        </span>
        <Toggle
          aria-label="주사위 판정"
          checked={!!settings.dice}
          disabled={busy || saving}
          onChange={(dice) => void save({ dice })}
        />
      </label>
      <label className="inu-switch-row inu-tall">
        <span>
          정보 접근 관리<small>인물별로 아는 정보와 근거를 기록해요</small>
        </span>
        <Toggle
          aria-label="정보 접근 관리"
          checked={!!settings.knowledge}
          disabled={busy || saving}
          onChange={(knowledge) =>
            void save({
              knowledge,
              ...(knowledge && settings.knowledgeFromTurn == null
                ? { knowledgeFromTurn: Math.max(0, turn) }
                : {}),
            })
          }
        />
      </label>
      <p className="inu-help">
        각각 켜고 끌 수 있어요. 모두 끄면 두 기능의 프롬프트·보조 호출은
        사용하지 않아요. 켜면 현재 턴의 API 키로 보조 모델 비용이 발생해요.
      </p>
      {settings.dice && (
        <label className="inu-switch-row">
          <span>
            리롤 시 주사위도 다시 굴리기
            <small>
              끄면 같은 행동의 결과를 유지해요. 전개 방향을 새로 입력하면
              재판정해요
            </small>
          </span>
          <Toggle
            aria-label="리롤 시 주사위 다시 굴리기"
            checked={!!settings.rerollDice}
            disabled={busy || saving}
            onChange={(rerollDice) => void save({ rerollDice })}
          />
        </label>
      )}
      {settings.knowledge && (
        <label className="inu-field">
          <span>기록 시작 시점</span>
          <select
            disabled={busy || saving}
            value={settings.knowledgeFromTurn === 0 ? "all" : "current"}
            onChange={(e) =>
              void save({
                knowledgeFromTurn:
                  e.target.value === "all" ? 0 : Math.max(0, turn),
              })
            }
          >
            <option value="current">
              현재 장면부터 ({settings.knowledgeFromTurn ?? turn}턴)
            </option>
            <option value="all">처음부터 · 과거 내역 추가 처리</option>
          </select>
          <small>
            처음부터 정리하면 활성 대화를 순서대로 처리해요. 대화가 길수록 최초
            비용과 대기 시간이 늘어나요.
          </small>
        </label>
      )}
      <button
        type="button"
        className="inu-button inu-full"
        disabled={saving || busy}
        onClick={() => void refresh()}
      >
        정보 표 · 판정 내역 새로 보기
      </button>
      {context && (
        <p className="inu-help">
          보조 모델 누적 ${Number(context.cost).toFixed(6)} · 입력{" "}
          {context.inputTokens.toLocaleString()} / 출력{" "}
          {context.outputTokens.toLocaleString()} 토큰 · 메인 비용과 별도
        </p>
      )}
      <p role="status" className="inu-help">
        {message}
      </p>
      {state && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm">
            인물별 정보 표 · {state.facts.length}개 정보 / {state.actors.length}
            명
          </summary>
          <p className="inu-help">
            비밀을 포함한 관리용 표예요. 사용자의 열람과 PC가 아는 정보는
            별개예요. X는 인지 근거 미확인이에요.
          </p>
          <input
            aria-label="정보 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="정보·인물 검색"
            className="inu-input my-2 w-full"
          />
          <select
            aria-label="정보 분류"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="inu-input mb-2"
          >
            <option value="all">전체</option>
            <option value="pc">PC 정보</option>
            <option value="event">사건</option>
            <option value="npc">NPC 정보</option>
          </select>
          <div className="max-h-96 overflow-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className="min-w-40 border border-current/20 p-2 text-left">
                    정보
                  </th>
                  {state.actors.map((a) => (
                    <th
                      key={a.name}
                      className="min-w-20 border border-current/20 p-2"
                    >
                      {a.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {facts.slice(0, limit).map((f) => (
                  <tr key={f.id}>
                    <td className="border border-current/20 p-2">
                      {f.secret ? "[비밀] " : ""}
                      {f.text}
                    </td>
                    {state.actors.map((a) => {
                      const k = relations.get(`${f.id}\u0000${a.name}`);
                      return (
                        <td
                          key={a.name}
                          className="border border-current/20 p-2 text-center"
                        >
                          <button
                            aria-label={`${a.name} · ${f.text} · ${k?.status === "knows" ? "O" : k ? "추측" : "X"}`}
                            title={k?.reason ?? "확인된 인지 근거 없음"}
                            onClick={() => {
                              setInspect({ fact: f, actor: a.name, value: k });
                              setReason(k?.reason ?? "");
                            }}
                            className="min-h-8 min-w-8 underline decoration-dotted"
                          >
                            {k?.status === "knows" ? "O" : k ? "△" : "X"}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {facts.length > limit && (
            <button
              className="inu-button mt-2"
              onClick={() => setLimit((v) => v + 100)}
            >
              정보 100개 더 보기
            </button>
          )}
          {inspect && (
            <div className="mt-3 rounded-lg border border-current/20 p-3">
              <strong>
                {inspect.actor} · {inspect.fact.text}
              </strong>
              <p className="inu-help">
                {inspect.value?.reason ?? "확인된 인지 근거가 없어요."}
              </p>
              {inspect.value?.quote && (
                <blockquote className="my-2 border-l-2 border-current/30 pl-2 text-xs">
                  {inspect.value.quote}
                </blockquote>
              )}
              <input
                aria-label="인지 경위 정정"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="알게 된 경위"
                className="inu-input w-full"
              />
              <div className="mt-2 flex gap-2">
                <button
                  className="inu-button"
                  disabled={busy || saving || !settings.knowledge}
                  onClick={() => void correct(true)}
                >
                  O로 정정
                </button>
                <button
                  className="inu-button"
                  disabled={busy || saving || !settings.knowledge}
                  onClick={() => void correct(false)}
                >
                  X로 정정
                </button>
                <button className="inu-button" onClick={() => setInspect(null)}>
                  닫기
                </button>
              </div>
            </div>
          )}
        </details>
      )}
      {rolls.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm">최근 판정 내역</summary>
          {rolls.flat().map((r, i) => (
            <p key={i} className="inu-help">
              {r.actor} · {r.action} → d{r.die} {r.value} ·{" "}
              {r.outcome === "critical_success"
                ? "대성공"
                : r.outcome === "success"
                  ? "성공"
                  : "실패"}{" "}
              (성공 {r.successMin} 이상)
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
