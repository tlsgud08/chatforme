import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { cacheTurnChoices, supportsManualPromptCache, type CacheMessage } from '@/lib/llm/promptCache';
import type { Session } from '@/types/db';

interface Props {
  session: Session;
  model: string;
  turnCount: number;
  busy: boolean;
  onUpdate: (patch: Partial<Session>) => void;
}

export default function PromptCacheSettings({ session, model, turnCount, busy, onUpdate }: Props) {
  const [choices, setChoices] = useState<{ id: string; turn: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState(session.prompt_cache_message_id ?? '');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const saveLock = useRef(false);
  const supported = supportsManualPromptCache(model);
  const enabled = session.prompt_cache_enabled ?? false;
  const savedTarget = session.prompt_cache_message_id ?? '';
  const selected = choices.find((choice) => choice.id === savedTarget);
  const unavailable = !loading && !loadError && !!savedTarget && !selected;

  useEffect(() => { setTarget(session.prompt_cache_message_id ?? ''); }, [session.id, session.prompt_cache_message_id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    async function load() {
      const messages: CacheMessage[] = [];
      // Fetch metadata, not large message bodies; include every page and count
      // visible user turns rather than trusting legacy turn_index values.
      for (let from = 0; ; from += 500) {
        const { data, error } = await supabase.from('messages')
          .select('id,role,is_hidden,is_active_variant,generation_status')
          .eq('session_id', session.id).eq('is_active_variant', true)
          .order('created_at', { ascending: true }).order('id', { ascending: true })
          .range(from, from + 499);
        if (cancelled) return;
        if (error) throw error;
        messages.push(...(data ?? []) as CacheMessage[]);
        if (!data || data.length < 500) break;
      }
      if (!cancelled) setChoices(cacheTurnChoices(messages, session.summary_last_turn ?? 0));
    }
    void load().catch(() => {
      if (!cancelled) setLoadError('기준 턴을 불러오지 못했습니다. 다시 불러와 주세요.');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [session.id, session.summary_last_turn, turnCount, busy, revision]);

  async function save(nextEnabled: boolean, nextTarget: string) {
    if (saveLock.current || busy) return;
    if (nextEnabled && (!supported || loading || loadError || (nextTarget && !choices.some((c) => c.id === nextTarget)))) return;
    saveLock.current = true;
    setSaving(true);
    setStatus('');
    const patch = { prompt_cache_enabled: nextEnabled, prompt_cache_message_id: nextTarget || null };
    try {
      const { data, error } = await supabase.from('sessions').update(patch).eq('id', session.id).select('id').single();
      if (error || !data) throw error;
      onUpdate(patch);
      setStatus(nextEnabled ? '저장했습니다. 다음 채팅 요청부터 지정한 경계를 사용합니다.' : '명시적 캐시를 껐습니다. 자동 캐시는 계속 적용될 수 있습니다.');
    } catch {
      setStatus('캐시 설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }

  return (
    <section className="border-b border-surface2 py-4" aria-labelledby="prompt-cache-title">
      <h3 id="prompt-cache-title" className="text-sm font-semibold text-slate-300">명시적 캐시 설정</h3>
      <label className="mt-3 flex items-center justify-between gap-3 text-sm text-slate-200">
        <span>이 채팅방에서 사용</span>
        <input type="checkbox" checked={enabled}
          disabled={saving || busy || (!enabled && (!supported || loading || !!loadError || unavailable))}
          onChange={(event) => void save(event.target.checked, savedTarget)} />
      </label>
      {!supported && <p className="mt-2 text-xs text-amber-300">Gemini 모델에서 사용할 수 있어요. 현재 모델에는 명시적 캐시 설정을 전송하지 않습니다.</p>}
      <label htmlFor="prompt-cache-target" className="mt-3 block text-xs text-slate-400">캐시 기준 턴</label>
      <select id="prompt-cache-target" value={target} disabled={loading || saving || busy || !supported || !!loadError}
        onChange={(event) => setTarget(event.target.value)} className="mt-1 w-full rounded-lg bg-surface px-3 py-2 text-sm outline-none disabled:opacity-50">
        <option value="">시스템 프롬프트까지만</option>
        {target && !choices.some((choice) => choice.id === target) && <option value={target} disabled>기존 선택 — 현재 사용 불가</option>}
        {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.turn}턴 AI 답변까지</option>)}
      </select>
      <p className="mt-2 text-xs text-slate-400">
        {loading ? '기준 턴을 불러오는 중…' : !enabled ? '명시적 캐시 OFF' : !supported ? '현재 모델에서는 적용 안 됨' : loadError ? '지정 상태 확인 불가' : unavailable
          ? '선택한 답변이 요약·삭제·리롤로 문맥에서 빠져 명시적 캐시가 적용되지 않습니다. 기준을 다시 선택해 주세요.'
          : selected ? `${selected.turn}턴까지 캐시 지정 · 이후 ${Math.max(0, turnCount - selected.turn)}턴은 범위 밖`
          : '시스템 프롬프트까지 캐시 지정'}
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={loading || saving || busy || !supported || !!loadError || (!!target && !choices.some((c) => c.id === target))}
          onClick={() => void save(enabled, target)} className="flex-1 rounded-lg bg-brand py-2 text-xs font-semibold text-white disabled:opacity-50">{saving ? '저장 중…' : '기준 저장'}</button>
        <button type="button" disabled={loading || saving || busy || !supported || !!loadError || !choices.length}
          onClick={() => { const latest = choices.at(-1); if (latest) { setTarget(latest.id); void save(enabled, latest.id); } }}
          className="flex-1 rounded-lg bg-surface2 py-2 text-xs text-slate-200 disabled:opacity-50">최신 완료 턴으로 갱신</button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">기준은 자동으로 이동하지 않습니다. 시스템 프롬프트에는 작품 설정·페르소나·노트·요약도 포함됩니다. 기준이나 앞의 내용을 바꾸면 새 캐시 생성 비용이 발생할 수 있어요. 캐시는 만료될 수 있으며, 실제 적중은 응답의 캐시 읽기 토큰으로 확인해 주세요.</p>
      {loadError && <div className="mt-2 text-xs text-amber-300" role="alert">{loadError}<button type="button" onClick={() => setRevision((v) => v + 1)} className="ml-2 underline">다시 불러오기</button></div>}
      <p className="mt-2 text-xs text-slate-300" role="status">{status}</p>
    </section>
  );
}
