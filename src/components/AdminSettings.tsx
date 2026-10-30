import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { DEFAULT_WORK_COMBINATION_PROMPT } from '@/lib/workCombination';
import { DEFAULT_KNOWLEDGE_CONFIG, type KnowledgeConfig } from '@/lib/knowledge/types';
import defaultSemi from '@/lib/prompts/semi-multichat.md?raw';
import defaultSync from '@/lib/prompts/semi-sync-summary.md?raw';
import ModelSelector from './ModelSelector';

type PromptKey = 'system_prompt' | 'theme_prompt' | 'multichat_system_prompt' | 'summary_prompt' | 'semi_multichat_prompt' | 'semi_sync_summary_prompt' | 'work_combination_prompt';
type AdminDraft = Record<PromptKey, string> & { knowledge_config: Partial<KnowledgeConfig> };
const editors: { key: PromptKey; title: string; help: string; initial?: string }[] = [
  { key: 'system_prompt', title: '전역 시스템 프롬프트', help: '모든 채팅에 공통으로 적용되는 최상단 지시문입니다.' },
  { key: 'theme_prompt', title: '테마 변경 및 판단 전역 프롬프트', help: '유동적 테마의 선택 규칙입니다. 위치 무관 인식은 채팅방에서 별도로 켤 수 있습니다.' },
  { key: 'multichat_system_prompt', title: '멀티챗 전용 추가 프롬프트', help: '멀티챗에서 일반 전역 프롬프트 뒤에 추가됩니다.' },
  { key: 'summary_prompt', title: '전역 요약 프롬프트', help: '일반챗과 멀티챗의 요약 노트 생성에 공통 적용됩니다.' },
  { key: 'semi_multichat_prompt', title: '세미 멀티챗 프롬프트', help: '연결된 개인 세션의 정보 출처와 시간·해석 규칙입니다.', initial: defaultSemi },
  { key: 'semi_sync_summary_prompt', title: '동기화용 요약 프롬프트', help: '상대 세션에게 전달할 요약에만 사용됩니다.', initial: defaultSync },
  { key: 'work_combination_prompt', title: '작품 결합 지침', help: '메인 작품과 추가 작품 프롬프트 묶음 앞에 적용됩니다.', initial: DEFAULT_WORK_COMBINATION_PROMPT },
];
const columns = [...editors.map(e => e.key), 'knowledge_config'].join(',');
export default function AdminSettings() {
  const [draft, setDraft] = useState<AdminDraft | null>(null), [baseline, setBaseline] = useState<AdminDraft | null>(null);
  const [saving, setSaving] = useState(false), [message, setMessage] = useState(''), [attempt, setAttempt] = useState(0);
  const [password, setPassword] = useState(''), [confirm, setConfirm] = useState('');
  const lock = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setMessage('');
    void (async () => {
      try {
        const { data, error } = await supabase.from('platform_config').select(columns).eq('id', 1).abortSignal(controller.signal).single();
        if (error || !data) throw error ?? new Error('설정이 없습니다.');
        const value = data as unknown as AdminDraft;
        if (editors.some(e => typeof value[e.key] !== 'string') || !value.knowledge_config || typeof value.knowledge_config !== 'object') throw new Error('전체 관리자 설정을 불러오지 못했습니다.');
        if (!controller.signal.aborted) { setDraft(value); setBaseline(value); }
      } catch (error) { if (!controller.signal.aborted) setMessage((error as Error).message + ' 입력은 유지했습니다. 다시 불러와 주세요.'); }
    })();
    return () => controller.abort();
  }, [attempt]);
  const knowledge = { ...DEFAULT_KNOWLEDGE_CONFIG, ...draft?.knowledge_config };
  const dirty = !!draft && !!baseline && (JSON.stringify(draft) !== JSON.stringify(baseline) || !!password || !!confirm);
  const setKnowledge = (patch: Partial<KnowledgeConfig>) => setDraft(value => value && ({ ...value, knowledge_config: { ...DEFAULT_KNOWLEDGE_CONFIG, ...value.knowledge_config, ...patch } }));
  async function save() {
    if (!draft || !baseline || lock.current) return;
    if ((password || confirm) && (password.length < 8 || password !== confirm)) { setMessage('마스터 비밀번호는 8자 이상으로, 확인란과 동일하게 입력해 주세요.'); return; }
    if (!draft.summary_prompt.trim() || !draft.semi_sync_summary_prompt.trim() || !knowledge.recordPrompt.trim() || !knowledge.mainPrompt.trim() || !knowledge.model.trim() || !Number.isInteger(knowledge.maxOutputTokens) || knowledge.maxOutputTokens < 1000 || knowledge.maxOutputTokens > 32000) { setMessage('요약·정보 관리 프롬프트와 모델, 출력량(1,000~32,000)을 확인해 주세요.'); return; }
    lock.current = true; setSaving(true); setMessage('');
    const desired = { ...draft, knowledge_config: knowledge };
    try {
      const { data, error } = await supabase.rpc('save_admin_settings', { previous: baseline, desired, new_master_password: password || null });
      if (error || data !== true) throw error ?? new Error('저장 결과를 확인하지 못했습니다.');
      setDraft(desired); setBaseline(desired); setPassword(''); setConfirm(''); setMessage('전체 관리자 설정을 저장했습니다. 다음 요청부터 적용됩니다.');
    } catch (error) { setMessage((error as Error).message + ' 입력 내용은 유지했습니다.'); }
    finally { lock.current = false; setSaving(false); }
  }
  return <div data-settings-section="admin" className="flex flex-col gap-6">
    <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/30 bg-surface p-4 shadow-lg">
      <div><h2 className="font-semibold">관리자 설정</h2><p className="mt-1 text-xs text-slate-400">{dirty ? '저장하지 않은 변경사항이 있어요.' : '전체 설정을 한 번에 저장해요.'}</p></div>
      <button type="button" onClick={() => void save()} disabled={!draft || !baseline || saving} className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{saving ? '저장 중…' : '전체 설정 저장'}</button>
      {message && <p role="status" className="w-full break-words text-sm text-slate-400">{message}</p>}
      {!draft && <button type="button" onClick={() => setAttempt(n => n + 1)} className="text-sm underline">다시 불러오기</button>}
    </div>
    <fieldset disabled={!draft || saving} className="flex min-w-0 flex-col gap-6 disabled:opacity-60">
      {editors.map(editor => <section key={editor.key} className="rounded-lg border border-yellow-600/30 bg-yellow-950/20 p-4">
        <h3 className="mb-1 font-semibold text-yellow-400">{editor.title}</h3><p className="mb-3 text-xs text-slate-400">{editor.help}</p>
        <textarea aria-label={editor.title} value={draft?.[editor.key] ?? ''} rows={editor.key.includes('summary') ? 16 : 8} onChange={event => setDraft(value => value && ({ ...value, [editor.key]: event.target.value }))} className="w-full resize-y rounded-lg bg-surface p-3 font-mono text-xs leading-relaxed outline-none" />
        {editor.initial !== undefined && <button type="button" onClick={() => setDraft(value => value && ({ ...value, [editor.key]: editor.initial! }))} className="mt-2 text-xs underline">기본 문구 불러오기</button>}
      </section>)}
      <section className="rounded-lg border border-brand/30 bg-brand/5 p-4">
        <h3 className="mb-1 font-semibold text-brand">정보 접근 관리</h3><p className="mb-4 text-xs text-slate-400">기능을 켠 채팅방에만 적용돼요. 기록 모델은 사용 중인 OpenRouter API 키로 호출하며 비용은 정보표에 별도로 표시돼요.</p>
        <ModelSelector provider="openrouter" displayLabel={knowledge.model === DEFAULT_KNOWLEDGE_CONFIG.model ? 'DeepSeek Flash Latest' : undefined} model={knowledge.model} reasoning={knowledge.reasoning} onModelChange={model => setKnowledge({ model })} onReasoningChange={reasoning => setKnowledge({ reasoning })} customModelActionLabel="모델 추가" />
        <label className="mt-4 block text-xs text-slate-400">기록 모델 최대 출력 토큰<input aria-label="기록 모델 최대 출력 토큰" type="number" min={1000} max={32000} step={1000} value={knowledge.maxOutputTokens} onChange={event => setKnowledge({ maxOutputTokens: Number(event.target.value) })} className="mt-1 w-full rounded-lg bg-surface p-3 text-sm" /></label>
        {(['recordPrompt', 'mainPrompt'] as const).map(key => <label key={key} className="mt-5 block text-xs text-slate-400">{key === 'recordPrompt' ? '정보 기록 모델 프롬프트' : '메인 모델 정보 접근 규칙'}<textarea aria-label={key === 'recordPrompt' ? '정보 기록 모델 프롬프트' : '메인 모델 정보 접근 규칙'} rows={20} value={knowledge[key]} onChange={event => setKnowledge({ [key]: event.target.value })} className="mt-2 w-full resize-y rounded-lg bg-surface p-3 font-mono text-xs leading-relaxed outline-none" /><button type="button" onClick={() => setKnowledge({ [key]: DEFAULT_KNOWLEDGE_CONFIG[key] })} className="mt-2 text-xs underline">기본 프롬프트 불러오기</button></label>)}
      </section>
      <section className="rounded-lg border border-brand/30 p-4"><h3 className="font-semibold text-brand">회원가입 마스터 비밀번호</h3><p className="my-3 text-xs text-slate-400">변경할 때만 입력하세요. 비워 두면 기존 비밀번호를 유지해요.</p><input aria-label="새 마스터 비밀번호" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="새 마스터 비밀번호 (8자 이상)" className="mb-2 w-full rounded-lg bg-surface p-3 text-sm" /><input aria-label="새 마스터 비밀번호 확인" type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} placeholder="새 마스터 비밀번호 확인" className="w-full rounded-lg bg-surface p-3 text-sm" /></section>
    </fieldset>
  </div>;
}
