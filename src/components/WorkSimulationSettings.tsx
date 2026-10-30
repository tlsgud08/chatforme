import { useEffect, useRef, useState } from "react";
import { showConfirmDialog } from "@/lib/dialog";
import { supabase } from "@/lib/supabase";
import { loadWorkSimulation } from "@/lib/simulation/runtime";
import { validateRules } from "@/lib/simulation/core";
import {
  DEFAULT_RULES,
  DEFAULT_WORK,
  type WorkSimulation,
} from "@/lib/simulation/types";

export default function WorkSimulationSettings({
  workId,
  onDirtyChange,
}: {
  workId: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [value, setValue] = useState(DEFAULT_WORK),
    [rules, setRules] = useState(JSON.stringify(DEFAULT_RULES, null, 2)),
    [loaded, setLoaded] = useState(false),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState("");
  const raw = useRef<Partial<WorkSimulation>>({}),
    saved = useRef(""),
    lock = useRef(false),
    dirty = useRef(false);
  dirty.current = loaded && JSON.stringify({ value, rules }) !== saved.current;
  useEffect(() => {
    const c = new AbortController();
    setLoaded(false);
    void loadWorkSimulation(workId, c.signal)
      .then(async (r) => {
        if (c.signal.aborted) return;
        raw.current = r.raw;
        setValue(r.value);
        const text = JSON.stringify(r.value.rules, null, 2);
        setRules(text);
        saved.current = JSON.stringify({ value: r.value, rules: text });
        const draft = localStorage.getItem(
          `inuchat:simulation-work-draft:${workId}`,
        );
        if (draft) {
          try {
            const parsed = JSON.parse(draft);
            if (
              parsed.value &&
              typeof parsed.rules === "string" &&
              (await showConfirmDialog(
                "저장되지 않은 판정·정보 설정이 있어요",
                "이 브라우저의 임시 설정을 불러올까요?",
                "불러오기",
              ))
            ) {
              if (!c.signal.aborted) {
                setValue(parsed.value);
                setRules(parsed.rules);
              }
            } else
              localStorage.removeItem(
                `inuchat:simulation-work-draft:${workId}`,
              );
          } catch {
            localStorage.removeItem(`inuchat:simulation-work-draft:${workId}`);
          }
        }
        if (!c.signal.aborted) setLoaded(true);
      })
      .catch((e) => {
        if (!c.signal.aborted) setMessage(e.message);
      });
    return () => c.abort();
  }, [workId]);
  useEffect(() => {
    onDirtyChange(dirty.current);
    if (dirty.current) {
      try {
        localStorage.setItem(
          `inuchat:simulation-work-draft:${workId}`,
          JSON.stringify({ value, rules }),
        );
      } catch {
        setMessage("임시 저장 공간이 부족해요. 설정을 저장해 주세요.");
      }
    }
  }, [loaded, value, rules, onDirtyChange]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, []);
  async function save() {
    if (lock.current || !loaded) return;
    lock.current = true;
    setSaving(true);
    try {
      const parsed = validateRules(JSON.parse(rules));
      const desired = { ...value, rules: parsed };
      const { data, error } = await supabase.rpc("save_work_simulation", {
        target_work: workId,
        previous: raw.current,
        desired,
      });
      if (error || data !== true) throw error ?? new Error("저장 실패");
      raw.current = desired;
      setValue(desired);
      saved.current = JSON.stringify({ value: desired, rules });
      localStorage.removeItem(`inuchat:simulation-work-draft:${workId}`);
      setMessage(
        "작품별 설정을 저장했어요. 꺼진 기능의 페이로드에는 포함되지 않아요.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  return (
    <section className="space-y-4 rounded-xl bg-surface2 p-4">
      <h2 className="text-sm font-semibold">작품별 판정 · 정보 설정</h2>
      <p className="text-xs text-slate-400">
        이 공간은 아래 버튼으로 따로 저장해요. 주사위·정보 관리는 각 채팅방에서
        켤 수 있어요.
      </p>
      <label className="block text-sm">
        주사위 판정 설정
        <textarea
          aria-label="작품 주사위 판정 설정"
          disabled={!loaded || saving}
          rows={7}
          value={value.dicePrompt}
          onChange={(e) =>
            setValue((v) => ({ ...v, dicePrompt: e.target.value }))
          }
          placeholder="이 작품의 공격·탈출·설득 판정 기준과 장비·부상 등 상황 보정 기준"
          className="mt-2 w-full rounded-lg bg-surface p-3 text-sm"
        />
      </label>
      <label className="block text-sm">
        정보 관리 설정
        <textarea
          aria-label="작품 정보 관리 설정"
          disabled={!loaded || saving}
          rows={7}
          value={value.knowledgePrompt}
          onChange={(e) =>
            setValue((v) => ({ ...v, knowledgePrompt: e.target.value }))
          }
          placeholder="공개 신분과 비밀, 인물별 기존 지식, INFO 인물 등록 기준 등"
          className="mt-2 w-full rounded-lg bg-surface p-3 text-sm"
        />
      </label>
      <details>
        <summary className="cursor-pointer text-sm">주사위·능력치 규칙</summary>
        <p className="my-2 text-xs text-slate-400">
          die: 주사위 면 수, successMin/criticalMin: 성공/대성공 최소 눈,
          statStep: 능력 차이 보정 간격. actors에 인물명별 능력치를 적어요.
          미지정 수치는 0으로 계산해요. 대성공을 사용하지 않으려면 criticalMin을
          die+1로 지정해요.
        </p>
        <textarea
          aria-label="작품 주사위 수치 규칙"
          disabled={!loaded || saving}
          rows={16}
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          className="w-full rounded-lg bg-surface p-3 font-mono text-xs"
        />
      </details>
      <p role="status" className="text-xs text-slate-400">
        {message}
      </p>
      <button
        disabled={!loaded || saving}
        onClick={() => void save()}
        className="inu-button inu-primary"
      >
        {saving ? "저장 중…" : "판정·정보 설정 별도 저장"}
      </button>
    </section>
  );
}
