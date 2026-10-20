import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { cacheTurnChoices, type CacheMessage } from '@/lib/llm/promptCache';
import type { Session } from '@/types/db';
import Toggle from './Toggle';
import InterfaceIcon from './InterfaceIcon';

interface Props {
  session: Session;
  model: string;
  turnCount: number;
  busy: boolean;
  onUpdate: (patch: Partial<Session>) => void;
  compact?: boolean;
}

export default function PromptCacheSettings({ session, turnCount, busy, onUpdate, compact = false }: Props) {
  const [choices, setChoices] = useState<{ id: string; turn: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const saveLock = useRef(false);
  const enabled = session.prompt_cache_enabled ?? false;
  const autoLatest = session.prompt_cache_auto_latest ?? false;
  const savedTarget = session.prompt_cache_message_id ?? '';
  const selected = choices.find((choice) => choice.id === savedTarget);
  const unavailable = !loading && !loadError && !!savedTarget && !selected;

  const latestTurn = choices.at(-1)?.turn ?? 0;
  const savedTurn = selected?.turn;
  useEffect(() => {
    setTarget(savedTarget ? (savedTurn === undefined ? '' : String(savedTurn)) : '0');
  }, [session.id, savedTarget, savedTurn]);

  // Normalize on blur/save so typing a multi-digit turn is not interrupted.
  function normalizeTarget() {
    if (autoLatest) return null;
    if (!target.trim() || !Number.isFinite(Number(target))) {
      setStatus('캐시 기준 턴을 숫자로 입력해 주세요.');
      return null;
    }
    const turn = Math.min(latestTurn, Math.max(0, Math.floor(Number(target))));
    setTarget(String(turn));
    return turn;
  }

  function saveTarget() {
    const turn = normalizeTarget();
    if (turn === null) return;
    const choice = choices.filter((item) => item.turn === turn).at(-1);
    if (turn !== 0 && !choice) {
      setStatus('요약에 포함되었거나 완료된 AI 답변이 없는 턴입니다. 0 또는 요약 이후의 완료된 턴을 입력해 주세요.');
      return;
    }
    void save(enabled, choice?.id ?? '');
  }

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

  async function save(nextEnabled: boolean, nextTarget: string, nextAutoLatest = autoLatest) {
    if (saveLock.current || busy) return;
    if (nextEnabled && (loading || loadError || (!nextAutoLatest && nextTarget && nextTarget !== savedTarget && !choices.some((c) => c.id === nextTarget)))) return;
    saveLock.current = true;
    setSaving(true);
    setStatus('');
    const patch = { prompt_cache_enabled: nextEnabled, prompt_cache_message_id: nextTarget || null, prompt_cache_auto_latest: nextAutoLatest };
    try {
      const { data, error } = await supabase.from('sessions').update(patch).eq('id', session.id).select('id').single();
      if (error || !data) throw error;
      onUpdate(patch);
      setStatus(nextEnabled ? nextAutoLatest ? '저장했습니다. 매 요청에서 최신 완료 AI 답변까지 캐시를 지정합니다.' : '저장했습니다. 다음 채팅 요청부터 지정한 경계를 사용합니다.' : '명시적 캐시를 껐습니다. 자동 캐시는 계속 적용될 수 있습니다.');
    } catch {
      setStatus('캐시 설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }

  const Container = compact ? 'details' : 'div';
  return (
    <Container className={compact ? 'inu-section inu-accordion' : undefined}>
      {compact && <summary><div><h3><InterfaceIcon name="cache" />명시적 캐시</h3><p className="inu-summary">{!enabled ? '사용 안 함' : loading ? '불러오는 중…' : loadError ? '기준 확인 필요' : unavailable ? '기준 다시 설정 필요' : autoLatest ? '사용 중 · 최신 턴 자동 갱신' : `사용 중 · ${selected?.turn ?? 0}턴까지 수동 지정`}</p></div><InterfaceIcon name="down" /></summary>}
    <section className={compact ? 'inu-detail-body inu-cache-body' : 'border-b border-surface2 py-4'} aria-labelledby="prompt-cache-title">
      <h3 id="prompt-cache-title" className="text-sm font-semibold text-slate-300">명시적 캐시 설정</h3>
      <label className="mt-3 flex items-center justify-between gap-3 text-sm text-slate-200">
        <span>이 채팅방에서 사용</span>
        <Toggle aria-label="이 채팅방에서 명시적 캐시 사용" checked={enabled}
          disabled={saving || busy || (!enabled && (loading || !!loadError || (!autoLatest && unavailable)))}
          onChange={(checked) => void save(checked, savedTarget)} />
      </label>
      <label className="mt-3 flex items-center justify-between gap-3 text-sm text-slate-200">
        <span>매 턴 최신으로 갱신</span>
        <Toggle aria-label="명시적 캐시를 매 턴 최신으로 갱신" checked={autoLatest} disabled={saving || busy || loading || !!loadError}
          onChange={(checked) => void save(enabled, savedTarget, checked)} />
      </label>
      <p className="mt-1 text-[11px] text-slate-500">켜면 매 요청의 대화 기록에서 마지막 완료 AI 답변까지 지정합니다. 완료 답변이 없으면 시스템 프롬프트만 지정합니다.</p>
      <label htmlFor="prompt-cache-target" className="mt-3 block text-xs text-slate-400">캐시 기준 턴</label>
      <input id="prompt-cache-target" type="text" inputMode="numeric" pattern="[0-9]*"
        value={autoLatest ? String(latestTurn) : target} placeholder={unavailable ? '기준 턴을 다시 입력해 주세요' : '0'}
        disabled={autoLatest || loading || saving || busy || !!loadError}
        onChange={(event) => { setTarget(event.target.value); setStatus(''); }}
        onBlur={() => { normalizeTarget(); }}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveTarget(); } }}
        aria-describedby="prompt-cache-help"
        className="mt-1 w-full rounded-lg bg-surface px-3 py-2 text-sm outline-none disabled:opacity-50" />
      <p id="prompt-cache-help" className="mt-2 text-xs text-slate-400">
        0 = 시스템 프롬프트만 · 최신 선택 가능 턴: {loading ? '불러오는 중…' : latestTurn}
        <br />{autoLatest ? '자동 갱신 중에는 기준을 직접 입력하지 않아도 됩니다.' : '최신 턴보다 큰 숫자는 입력을 마치면 최신 턴으로 자동 수정됩니다. 기준 저장을 눌러 적용해 주세요.'}
      </p>
      <p className="mt-2 text-xs text-slate-400">
        {loading ? '기준 턴을 불러오는 중…' : !enabled ? '명시적 캐시 OFF' : loadError ? '지정 상태 확인 불가' : autoLatest ? `최신 완료 턴으로 자동 갱신 · 현재 ${latestTurn > 0 ? `${latestTurn}턴까지` : '시스템 프롬프트만'}` : unavailable
          ? '선택한 답변이 요약·삭제·리롤로 문맥에서 빠져 명시적 캐시가 적용되지 않습니다. 기준을 다시 선택해 주세요.'
          : selected ? `${selected.turn}턴까지 캐시 지정 · 이후 ${Math.max(0, turnCount - selected.turn)}턴은 범위 밖`
          : '시스템 프롬프트까지 캐시 지정'}
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={autoLatest || loading || saving || busy || !!loadError || !target.trim()}
          onClick={saveTarget} className="flex-1 rounded-lg bg-brand py-2 text-xs font-semibold text-white disabled:opacity-50">{saving ? '저장 중…' : '기준 저장'}</button>
        <button type="button" disabled={autoLatest || loading || saving || busy || !!loadError || !choices.length}
          onClick={() => { const latest = choices.at(-1); if (latest) { setTarget(String(latest.turn)); void save(enabled, latest.id); } }}
          className="flex-1 rounded-lg bg-surface2 py-2 text-xs text-slate-200 disabled:opacity-50">최신 완료 턴으로 갱신</button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">자동 갱신을 끄면 저장한 기준을 사용합니다. 시스템 프롬프트에는 작품 설정·페르소나·노트·요약도 포함됩니다. 기준이나 앞의 내용을 바꾸면 새 캐시 생성 비용이 발생할 수 있어요. 캐시는 만료될 수 있으며, 실제 적중은 응답의 캐시 읽기 토큰으로 확인해 주세요. 모델 및 제공업체에 따라 명시적 캐싱이 지원되지 않을 수 있어요.</p>
      {loadError && <div className="mt-2 text-xs text-amber-300" role="alert">{loadError}<button type="button" onClick={() => setRevision((v) => v + 1)} className="ml-2 underline">다시 불러오기</button></div>}
      <p className="mt-2 text-xs text-slate-300" role="status">{status}</p>
    </section>
    </Container>
  );
}
