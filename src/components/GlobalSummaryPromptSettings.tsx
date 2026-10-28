import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { loadGlobalSummaryPrompt } from '@/lib/summaryPrompt';

/** Rendered exclusively in the administrator tab; the database enforces writes. */
export default function GlobalSummaryPromptSettings() {
  const [prompt, setPrompt] = useState(''), [loaded, setLoaded] = useState(false), [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(''), [attempt, setAttempt] = useState(0);
  const baseline = useRef<string | null>(null), lock = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false); baseline.current = null; setMessage('');
    void loadGlobalSummaryPrompt(controller.signal).then(value => {
      if (!controller.signal.aborted) { baseline.current = value; setPrompt(value); setLoaded(true); }
    }).catch(() => { if (!controller.signal.aborted) setMessage('전역 요약 프롬프트를 불러오지 못했습니다. 다시 불러와 주세요.'); });
    return () => controller.abort();
  }, [attempt]);
  async function save() {
    if (!loaded || baseline.current == null || lock.current || !prompt.trim()) return;
    lock.current = true; setSaving(true); setMessage('');
    try {
      const { data, error } = await supabase.rpc('save_global_summary_prompt', { previous: baseline.current, desired: prompt });
      if (error || data !== true) throw error ?? new Error('저장 결과를 확인하지 못했습니다.');
      baseline.current = prompt; setMessage('전역 요약 프롬프트를 저장했습니다. 다음 요약 생성부터 모두에게 적용됩니다.');
    } catch (error) { setMessage(`${(error as Error).message} 입력 내용은 유지했습니다.`); }
    finally { lock.current = false; setSaving(false); }
  }
  return <section data-settings-section="admin" className="rounded-lg border border-yellow-600/30 bg-yellow-950/20 p-4">
    <h2 className="mb-1 font-semibold text-yellow-400">관리자 — 전역 요약 프롬프트</h2>
    <p className="mb-3 text-xs text-slate-400">일반챗과 멀티챗의 요약 노트 생성에 적용됩니다. 세션 동기화로 상대에게 보내는 요약은 별도의 동기화용 요약 프롬프트를 사용합니다. 개인별 프롬프트와 추가 지침은 사용하지 않습니다.</p>
    <textarea aria-label="전역 요약 프롬프트" rows={18} disabled={!loaded || saving} value={prompt} onChange={event => setPrompt(event.target.value)} className="w-full rounded-xl bg-surface p-3 font-mono text-xs leading-relaxed text-slate-200 outline-none disabled:opacity-50" />
    {message && <p role="status" className="mt-2 text-xs text-slate-400">{message}</p>}
    <div className="mt-3 flex gap-2">
      {!loaded && <button type="button" onClick={() => setAttempt(value => value + 1)} className="rounded-lg bg-surface2 px-4 py-2 text-sm text-white">다시 불러오기</button>}
      <button type="button" disabled={!loaded || saving || !prompt.trim()} onClick={() => void save()} className="rounded-lg bg-yellow-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? '저장 중…' : '전역 요약 프롬프트 저장'}</button>
    </div>
  </section>;
}
