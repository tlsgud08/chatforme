import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import defaultPrompt from '@/lib/prompts/semi-multichat.md?raw';
import defaultSyncPrompt from '@/lib/prompts/semi-sync-summary.md?raw';

const editors = {
  context: { column: 'semi_multichat_prompt', rpc: 'save_semi_multichat_prompt', title: '세미 멀티챗 프롬프트', draft: defaultPrompt, draftLabel: '연동 규약 초안 불러오기', required: false,
    description: '연결된 개인 세션의 대화 생성에 추가됩니다. PC는 내 페르소나, PC2는 상대이며 정보의 출처·시간·해석 규칙을 지정합니다.' },
  sync: { column: 'semi_sync_summary_prompt', rpc: 'save_semi_sync_summary_prompt', title: '동기화용 요약 프롬프트', draft: defaultSyncPrompt, draftLabel: '동기화 요약 초안 불러오기', required: true,
    description: '세션 연동에서 상대에게 보낼 요약 생성에만 사용합니다. 일반 요약 프롬프트와 독립적이며, 생성 결과는 본인의 요약 노트에 반영하지 않습니다.' },
} as const;

export function SemiPromptEditor({ kind }: { kind: keyof typeof editors }) {
  const config = editors[kind];
  const [prompt, setPrompt] = useState(''), [loaded, setLoaded] = useState(false), [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(''), [attempt, setAttempt] = useState(0);
  const baseline = useRef<string | null>(null), lock = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false); setMessage(''); baseline.current = null;
    void (async () => {
      try {
        const { data, error } = await supabase.from('platform_config').select(config.column).eq('id', 1).abortSignal(controller.signal).single();
        const value = (data as Record<string, unknown> | null)?.[config.column];
        if (error || typeof value !== 'string') throw error ?? new Error('설정이 없습니다.');
        if (!controller.signal.aborted) { baseline.current = value; setPrompt(value); setLoaded(true); }
      } catch { if (!controller.signal.aborted) setMessage(`${config.title}를 불러오지 못했습니다.`); }
    })();
    return () => controller.abort();
  }, [attempt, config]);
  async function save() {
    if (!loaded || baseline.current == null || lock.current || (config.required && !prompt.trim())) return;
    lock.current = true; setSaving(true); setMessage('');
    try {
      const { data, error } = await supabase.rpc(config.rpc, { previous: baseline.current, desired: prompt });
      if (error || data !== true) throw error ?? new Error('저장 결과를 확인하지 못했습니다.');
      baseline.current = prompt; setMessage(kind === 'sync' ? '저장했습니다. 다음 전달용 요약 생성부터 적용됩니다.' : '저장했습니다. 연결된 세션의 다음 AI 요청부터 적용됩니다.');
    } catch (error) { setMessage(`${(error as Error).message} 입력 내용은 유지했습니다.`); }
    finally { lock.current = false; setSaving(false); }
  }
  return <section data-settings-section="admin" className="rounded-lg border border-yellow-600/30 bg-yellow-950/20 p-4">
    <h2 className="mb-1 font-semibold text-yellow-400">관리자 — {config.title}</h2>
    <p className="mb-3 text-xs text-slate-400">{config.description}</p>
    <textarea aria-label={config.title} rows={18} disabled={!loaded || saving} value={prompt} onChange={event => setPrompt(event.target.value)} className="w-full rounded-xl bg-surface p-3 font-mono text-xs leading-relaxed text-slate-200 outline-none disabled:opacity-50" />
    {message && <p role="status" className="mt-2 text-xs text-slate-400">{message}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {!loaded && <button type="button" onClick={() => setAttempt(value => value + 1)} className="rounded-lg bg-surface2 px-4 py-2 text-sm text-white">다시 불러오기</button>}
      <button type="button" disabled={!loaded || saving || (config.required && !prompt.trim())} onClick={() => void save()} className="rounded-lg bg-yellow-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? '저장 중…' : `${config.title} 저장`}</button>
      <button type="button" disabled={!loaded || saving} onClick={() => { setPrompt(config.draft); setMessage('초안을 불러왔습니다. 검토 후 저장해 주세요.'); }} className="rounded-lg bg-surface2 px-4 py-2 text-sm text-white disabled:opacity-50">{config.draftLabel}</button>
    </div>
  </section>;
}

export default function SemiMultichatPromptSettings() { return <SemiPromptEditor kind="context" />; }
export function SemiSyncSummaryPromptSettings() { return <SemiPromptEditor kind="sync" />; }
