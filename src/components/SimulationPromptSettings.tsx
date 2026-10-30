import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { loadSimulationPrompts } from "@/lib/simulation/runtime";
import {
  DEFAULT_PROMPTS,
  type SimulationPrompts,
} from "@/lib/simulation/types";

export default function SimulationPromptSettings() {
  const [value, setValue] = useState<SimulationPrompts>(DEFAULT_PROMPTS),
    [loaded, setLoaded] = useState(false),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState(""),
    [attempt, setAttempt] = useState(0);
  const baseline = useRef<Partial<SimulationPrompts> | null>(null),
    lock = useRef(false);
  useEffect(() => {
    const c = new AbortController();
    setLoaded(false);
    void loadSimulationPrompts(c.signal)
      .then((r) => {
        if (!c.signal.aborted) {
          baseline.current = r.raw;
          setValue(r.value);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setMessage(String(e.message));
      });
    return () => c.abort();
  }, [attempt]);
  async function save() {
    if (!loaded || !baseline.current || lock.current) return;
    lock.current = true;
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc("save_simulation_prompts", {
        previous: baseline.current,
        desired: value,
      });
      if (error || data !== true) throw error ?? new Error("저장 실패");
      baseline.current = value;
      setMessage("저장했습니다. 켜진 기능의 다음 요청부터 적용돼요.");
    } catch (e) {
      setMessage((e as Error).message + " 입력 내용은 유지했어요.");
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  return (
    <section
      data-settings-section="admin"
      className="rounded-lg border border-yellow-600/30 bg-yellow-950/20 p-4"
    >
      <h2 className="mb-2 font-semibold text-yellow-400">
        관리자 — 주사위 · 정보 관리
      </h2>
      <p className="mb-3 text-xs text-slate-400">
        기능별 전역 규칙이에요. 해당 기능이 꺼진 세션에는 전송하지 않아요. 실제
        난수와 판정 구간 계산은 사이트가 처리해요.
      </p>
      {(["dice", "knowledge"] as const).map((key) => (
        <label key={key} className="mb-4 block text-sm">
          {key === "dice" ? "주사위 판정 프롬프트" : "정보 관리 프롬프트"}
          <textarea
            aria-label={
              key === "dice"
                ? "전역 주사위 판정 프롬프트"
                : "전역 정보 관리 프롬프트"
            }
            rows={10}
            disabled={!loaded || saving}
            value={value[key]}
            onChange={(e) => setValue((v) => ({ ...v, [key]: e.target.value }))}
            className="mt-2 w-full rounded-lg bg-surface p-3 text-xs leading-relaxed text-white outline-none disabled:opacity-50"
          />
        </label>
      ))}
      {(["analystModel", "verifierModel"] as const).map((key) => (
        <label key={key} className="mb-3 block text-xs text-slate-400">
          {key === "analystModel"
            ? "행동 분석·정보 추출 모델"
            : "정보 근거 검증 모델 (Decisions API)"}
          <input
            disabled={!loaded || saving}
            aria-label={key}
            value={value[key]}
            onChange={(e) => setValue((v) => ({ ...v, [key]: e.target.value }))}
            className="mt-1 w-full rounded-lg bg-surface px-3 py-2 text-white"
          />
        </label>
      ))}
      <p role="status" className="text-xs text-slate-400">
        {message}
      </p>
      <div className="mt-3 flex gap-2">
        {!loaded && (
          <button
            className="inu-button"
            onClick={() => setAttempt((v) => v + 1)}
          >
            다시 불러오기
          </button>
        )}
        <button
          className="inu-button inu-primary"
          disabled={
            !loaded ||
            saving ||
            !value.dice.trim() ||
            !value.knowledge.trim() ||
            !value.analystModel.trim() ||
            !value.verifierModel.trim()
          }
          onClick={() => void save()}
        >
          {saving ? "저장 중…" : "전역 판정·정보 규칙 저장"}
        </button>
      </div>
    </section>
  );
}
