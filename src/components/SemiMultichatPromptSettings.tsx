import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

export default function SemiMultichatPromptSettings() {
  const [prompt, setPrompt] = useState(''), [loaded, setLoaded] = useState(false), [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(''), [attempt, setAttempt] = useState(0);
  const baseline = useRef<string | null>(null), lock = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false); setMessage(''); baseline.current = null;
    void (async () => {
      try {
        const { data, error } = await supabase.from('platform_config').select('semi_multichat_prompt').eq('id', 1).abortSignal(controller.signal).single();
        if (error || typeof data?.semi_multichat_prompt !== 'string') throw error ?? new Error('설정이 없습니다.');
        if (!controller.signal.aborted) { baseline.current = data.semi_multichat_prompt; setPrompt(data.semi_multichat_prompt); setLoaded(true); }
      } catch { if (!controller.signal.aborted) setMessage('세미 멀티챗 프롬프트를 불러오지 못했습니다.'); }
    })();
    return () => controller.abort();
  }, [attempt]);
  async function save() {
    if (!loaded || baseline.current == null || lock.current) return;
    lock.current = true; setSaving(true); setMessage('');
    try {
      const { data, error } = await supabase.rpc('save_semi_multichat_prompt', { previous: baseline.current, desired: prompt });
      if (error || data !== true) throw error ?? new Error('저장 결과를 확인하지 못했습니다.');
      baseline.current = prompt; setMessage('저장했습니다. 연결된 세션의 다음 AI 요청부터 적용됩니다.');
    } catch (error) { setMessage(`${(error as Error).message} 입력 내용은 유지했습니다.`); }
    finally { lock.current = false; setSaving(false); }
  }
  return <section data-settings-section="admin" className="rounded-lg border border-yellow-600/30 bg-yellow-950/20 p-4">
    <h2 className="mb-1 font-semibold text-yellow-400">관리자 — 세미 멀티챗 프롬프트</h2>
    <p className="mb-3 text-xs text-slate-400">연결된 개인 세션의 대화 생성에만 추가됩니다. PC는 내 페르소나, PC2는 상대입니다. 전달용 요약 생성에는 기존 전역 요약 프롬프트를 사용합니다.</p>
    <textarea aria-label="세미 멀티챗 프롬프트" rows={12} disabled={!loaded || saving} value={prompt} onChange={event => setPrompt(event.target.value)} className="w-full rounded-xl bg-surface p-3 font-mono text-xs leading-relaxed text-slate-200 outline-none disabled:opacity-50" />
    {message && <p role="status" className="mt-2 text-xs text-slate-400">{message}</p>}
    <div className="mt-3 flex gap-2">
      {!loaded && <button type="button" onClick={() => setAttempt(value => value + 1)} className="rounded-lg bg-surface2 px-4 py-2 text-sm text-white">다시 불러오기</button>}
      <button type="button" disabled={!loaded || saving} onClick={() => void save()} className="rounded-lg bg-yellow-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? '저장 중…' : '세미 멀티챗 프롬프트 저장'}</button>
    </div>
  </section>;
}
