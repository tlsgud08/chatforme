import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { emptyState, knowledgeSymbol } from '@/lib/knowledge/core';
import { cancelKnowledge, readKnowledgeContext, replayContext } from '@/lib/knowledge/runtime';
import { generateKnowledgeNow } from '@/lib/knowledge/manual';
import { getApiKey } from '@/lib/apiKeys';
import { registerAccountTask } from '@/lib/accountTasks';
import type { Fact, Knowledge, KnowledgeContext } from '@/lib/knowledge/types';
import type { Session } from '@/types/db';
import Toggle from './Toggle';
import { showConfirmDialog } from '@/lib/dialog';

export default function SessionInformationSettings({ session, busy, onUpdate }: { session: Session; busy: boolean; onUpdate: (patch: Partial<Session>) => void }) {
  const [open, setOpen] = useState(false), [context, setContext] = useState<KnowledgeContext | null>(null);
  const [message, setMessage] = useState(''), [saving, setSaving] = useState(false), [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [view, setView] = useState('cards'), [actorFilter, setActorFilter] = useState('');
  const [kind, setKind] = useState('all'), [search, setSearch] = useState(''), [limit, setLimit] = useState(100);
  const [inspect, setInspect] = useState<{ fact: Fact; actor: string; value?: Knowledge } | null>(null);
  const [status, setStatus] = useState<Knowledge['status']>('unknown'), [reason, setReason] = useState('');
  const request = useRef(0);
  const lock = useRef(false), route = useRef(session.id); route.current = session.id;
  const manual = useRef<AbortController | null>(null), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; manual.current?.abort(); };
  }, [session.id, session.knowledge_enabled, busy]);
  async function refresh() {
    const id = session.id, sequence = ++request.current; setLoading(true); setMessage('');
    try { const value = await readKnowledgeContext(id); if (mounted.current && route.current === id && request.current === sequence) { setContext(value); return true; } return false; }
    catch (error) { if (mounted.current && route.current === id && request.current === sequence) setMessage((error as Error).message); return false; }
    finally { if (mounted.current && route.current === id && request.current === sequence) setLoading(false); }
  }
  async function generateNow() {
    if (busy || lock.current || !session.knowledge_enabled) return;
    lock.current = true;
    const id = session.id, controller = new AbortController(), unregister = registerAccountTask(controller);
    manual.current = controller; setGenerating(true); setOpen(true); setMessage('');
    try {
      const result = await generateKnowledgeNow(id, getApiKey('openrouter'), controller.signal);
      controller.signal.throwIfAborted();
      if (mounted.current && route.current === id && await refresh() && !controller.signal.aborted)
        setMessage(result.processed ? '정보표 생성/갱신을 완료했어요.' : '새로 반영할 정보가 없어요. 최신 정보표예요.');
    } catch (error) {
      if (mounted.current && route.current === id) setMessage(controller.signal.aborted ? '정보 정리를 중단했어요. 완료한 부분은 유지되며 다음 실행에서 이어서 처리해요.' : (error as Error).message);
    } finally {
      unregister();
      if (manual.current === controller) { manual.current = null; lock.current = false; if (mounted.current && route.current === id) setGenerating(false); }
    }
  }
  useEffect(() => { setContext(null); setInspect(null); if (open) void refresh(); return () => { request.current++; }; }, [session.id, open, busy, session.knowledge_revision]);
  useEffect(() => {
    if (!open) return;
    const listener = (event: Event) => { if ((event as CustomEvent<string>).detail === session.id) void refresh(); };
    window.addEventListener('inuchat:knowledge-updated', listener);
    return () => window.removeEventListener('inuchat:knowledge-updated', listener);
  }, [session.id, open]);
  useEffect(() => setLimit(100), [kind, search]);
  useEffect(() => setActorFilter(''), [session.id]);
  const replay = useMemo(() => context ? replayContext(context) : { state: emptyState(), pending: [] }, [context]);
  const state = replay.state;
  const relations = useMemo(() => new Map(state.knowledge.map(k => [`${k.fact}\0${k.actor}`, k])), [context]);
  async function toggle(knowledge: boolean) {
    if (busy || lock.current) return; lock.current = true; setSaving(true); setMessage('');
    try {
      const { data, error } = await supabase.rpc('set_information_features', { target_session: session.id, previous_revision: session.knowledge_revision ?? 0,
        // Retain the deployed RPC signature; tag recognition no longer reads this legacy flag.
        knowledge, theme_anywhere: true });
      if (error || !data) throw error ?? new Error('설정을 저장하지 못했습니다.'); onUpdate(data as Partial<Session>);
    } catch (error) { setMessage((error as Error).message); }
    finally { lock.current = false; setSaving(false); }
  }
  async function clearTable() {
    if (busy || lock.current) return;
    lock.current = true;
    const id = session.id;
    try {
      if (!await showConfirmDialog('정보표 전체를 삭제할까요?', '모든 정보·인물·인지 경위를 삭제하고 정보 접근 관리를 꺼요. 직접 정정한 내용도 삭제돼요.\n대화 원문·요약 메모리·사용 비용 기록은 유지돼요. 다시 켜면 기존 대화에서 새로 생성할 수 있어요.', '전체 삭제')) return;
      if (!mounted.current || route.current !== id) return;
      setSaving(true); setMessage('');
      const { data, error } = await supabase.rpc('clear_information_table', { target_session: id, previous_revision: session.knowledge_revision ?? 0 });
      if (error || !data) throw error ?? new Error('정보표를 삭제하지 못했습니다.');
      cancelKnowledge(id);
      if (mounted.current && route.current === id) {
        request.current++; setContext(null); setInspect(null); setSearch(''); setActorFilter('');
        onUpdate(data as Partial<Session>);
        setMessage('정보표를 전체 삭제하고 정보 접근 관리를 껐어요.');
      }
    } catch (error) { if (mounted.current && route.current === id) setMessage((error as Error).message); }
    finally { lock.current = false; if (mounted.current && route.current === id) setSaving(false); }
  }
  async function correct() {
    if (!inspect || !context || busy || lock.current || !session.knowledge_enabled) return;
    const row = context.entries.at(-1);
    if (!row?.patch || replay.pending.length) { setMessage('정보 정리를 마친 뒤 수정해 주세요.'); return; }
    if (status !== 'unknown' && !reason.trim()) { setMessage('인지 경위 또는 의심·오해의 내용을 입력해 주세요.'); return; }
    lock.current = true; setSaving(true); setMessage('');
    const relation: Knowledge = { fact: inspect.fact.id, actor: inspect.actor, status, reason: reason.trim(), source: row.id, quote: '사용자 직접 정정' };
    try {
      const desired = { ...row.patch, knowledge: [...row.patch.knowledge.filter(k => !(k.fact === relation.fact && k.actor === relation.actor)), relation] };
      const { error } = await supabase.rpc('save_knowledge_event', { target_session: session.id, target_message: row.id, expected_hash: row.source_hash,
        desired, setup_hash: row.setup_hash, expected_revision: context.revision, expected_previous: row.patch });
      if (error) throw error; setInspect(null); await refresh();
    } catch (error) { setMessage((error as Error).message); }
    finally { lock.current = false; setSaving(false); }
  }
  function selectCell(fact: Fact, actor: string) {
    const value = relations.get(`${fact.id}\0${actor}`);
    setInspect({ fact, actor, value }); setStatus(value?.status ?? 'unknown'); setReason(value?.reason ?? '');
  }
  const actors = state.actors.filter(actor => !actorFilter || actor.name === actorFilter);
  const inspector = inspect && <div className="min-w-0 rounded-lg border border-brand/30 p-3"><h4 className="break-words font-semibold">{inspect.actor} — 인지 경위 정정</h4>
    {inspect.value?.quote && <details className="my-2 text-sm"><summary className="cursor-pointer">원문 근거 보기</summary><blockquote className="mt-2 whitespace-pre-wrap break-words text-slate-400">{inspect.value.quote}</blockquote></details>}
    <select aria-label="인지 상태" value={status} disabled={!session.knowledge_enabled || busy || saving || generating} onChange={event => setStatus(event.target.value as Knowledge['status'])}><option value="knows">O · 알고 있음</option><option value="suspects">△ · 의심</option><option value="believes">△ · 오해/소문을 믿음</option><option value="unknown">X · 모름</option></select>
    <textarea aria-label="인지 경위 정정" rows={3} value={reason} disabled={!session.knowledge_enabled || busy || saving || generating} onChange={event => setReason(event.target.value)} placeholder="알게 된 경위 또는 실제로 의심·오해하는 내용" />
    <div className="mt-2 flex flex-wrap gap-2"><button type="button" className="inu-button inu-primary" disabled={!session.knowledge_enabled || busy || saving || generating || !!replay.pending.length} onClick={() => void correct()}>정정 저장</button><button type="button" className="inu-button" onClick={() => setInspect(null)}>닫기</button></div>
  </div>;
  const facts = state.facts.filter(f => (kind === 'all' || f.kind === kind) && (!search || f.text.includes(search) || f.subjects.some(n => n.includes(search))));
  return <section className="inu-section">
    <h3>정보 접근 관리</h3>
    <label className="inu-switch-row inu-tall"><span>정보 접근 관리<small>인물별 O·△·X와 경위를 기록하고 메인 AI에 전달해요</small></span><Toggle aria-label="정보 접근 관리" checked={session.knowledge_enabled === true} disabled={busy || saving || generating} onChange={knowledge => void toggle(knowledge)} /></label>
    <p className="inu-help">정보 관리를 끄면 기존 전송 방식을 그대로 사용해요. 변화 감지·기록 모델의 추가 비용이 발생할 수 있어요. 처음 켜면 기존 대화도 차례로 정리해요.</p>
    <button type="button" className="inu-button inu-full" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '정보표 닫기' : '정보표 열기'}</button>
    <button type="button" className="inu-button inu-primary inu-full" disabled={!session.knowledge_enabled || busy || saving || generating} aria-busy={generating} onClick={() => void generateNow()}>{generating ? '정보 정리 중…' : '지금 생성/갱신'}</button>
    <p className="inu-help">처음에는 설정과 기존 대화를 정리하고, 이후에는 미처리 내용만 반영해요. 모델 사용 비용이 발생할 수 있어요.</p>
    {generating && <button type="button" className="inu-text-button" onClick={() => manual.current?.abort()}>정보 정리 중단</button>}
    <button type="button" className="inu-button inu-full" disabled={busy || saving || generating} onClick={() => void clearTable()}>정보표 전체 삭제</button>
    {message && <p role="status" className="inu-help">{message}</p>}
    {open && <div className="mt-3 flex min-w-0 flex-col gap-3">
      <p className="inu-help">O: 알고 있음 · △: 의심/오해 · X: 인지 근거 없음. 인지 경위는 각 인물 아래 표시돼요. 인물을 누르면 원문 확인과 정정이 가능해요. 표에는 PC가 모르는 비밀도 포함돼요.</p>
      <div className="flex min-w-0 gap-2"><input className="min-w-0 flex-1" aria-label="정보 검색" value={search} onChange={event => setSearch(event.target.value)} placeholder="정보 검색" /><button type="button" className="inu-button shrink-0 whitespace-nowrap" disabled={loading} onClick={() => void refresh()}>{loading ? '조회 중…' : '새로고침'}</button></div>
      <select aria-label="정보 종류" value={kind} onChange={event => setKind(event.target.value)}><option value="all">전체 정보</option><option value="pc">PC 정보</option><option value="event">사건</option><option value="npc">NPC 정보</option></select>
      {session.knowledge_enabled && replay.pending.length > 0 && <p role="status" className="inu-help">{replay.pending.filter(e => e.turn_index >= 0).length}개 응답의 정리가 필요해요. 다음 생성 전에 이어서 처리해요.</p>}
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <select aria-label="정보 보기 방식" value={view} onChange={event => setView(event.target.value)}><option value="cards">카드 보기</option><option value="table">표 보기</option></select>
        <select aria-label="인지 인물 필터" value={actorFilter} onChange={event => setActorFilter(event.target.value)}><option value="">모든 인물 ({state.actors.length})</option>{state.actors.map(actor => <option key={actor.name} value={actor.name}>{actor.name}{actor.pc ? ' (PC)' : ''}</option>)}</select>
      </div>
      <p className="inu-help">{facts.length}개 정보 · {state.actors.length}명{replay.pending.length ? ' · 미처리 대화의 인물·PC 정보는 정리 후 반영돼요.' : ''}</p>
      {view === 'cards' ? <div className="flex min-w-0 flex-col gap-3">{facts.slice(0, limit).map(fact => <article key={fact.id} className="min-w-0 rounded-xl border border-slate-500/25 bg-surface2 p-3">
        <div className="mb-2 flex flex-wrap gap-2 text-xs text-slate-400"><span>{fact.kind === 'pc' ? 'PC 정보' : fact.kind === 'npc' ? 'NPC 정보' : '사건'}</span>{fact.secret && <span className="text-amber-400">비밀 · PC가 모를 수 있음</span>}</div>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{fact.text}</p>
        {fact.details && <details className="mt-2 text-xs text-slate-400"><summary className="cursor-pointer">통합 전 기록·근거 ({fact.details.length})</summary><ul className="mt-2 space-y-2">{fact.details.map((detail, i) => <li key={i} className="whitespace-pre-wrap break-words">{detail.text}{detail.quote && <blockquote className="mt-1">{detail.quote}</blockquote>}{detail.knowledge?.map(value => <p key={value.actor} className="mt-1">{value.actor}: {knowledgeSymbol(value.status)} · {value.reason}</p>)}</li>)}</ul></details>}
        <div className="mt-3 divide-y divide-slate-500/20 border-t border-slate-500/20">{actors.map(actor => {
          const value = relations.get(`${fact.id}\0${actor.name}`);
          return <button key={actor.name} type="button" className="block w-full min-w-0 py-3 text-left" aria-label={`${actor.name}: ${fact.text} — ${knowledgeSymbol(value?.status)}`} aria-expanded={inspect?.fact.id === fact.id && inspect.actor === actor.name} onClick={() => selectCell(fact, actor.name)}>
            <span className="flex items-start gap-2"><span className="w-6 shrink-0 font-semibold text-brand">{knowledgeSymbol(value?.status)}</span><span className="min-w-0 break-words text-sm font-semibold">{actor.name}{actor.pc ? ' (PC)' : ''}{value?.status === 'believes' ? ' · 오해/소문' : value?.status === 'suspects' ? ' · 의심' : ''}</span></span>
            <span className="mt-1 block whitespace-pre-wrap break-words pl-8 text-sm leading-relaxed text-slate-400">{value?.reason || (value && value.status !== 'unknown' ? '저장된 인지 경위가 없어요. 원문을 확인해 주세요.' : '인지 근거 없음')}</span>
          </button>;
        })}</div>
        {inspect?.fact.id === fact.id && inspector}
      </article>)}</div> : <><p className="inu-help">표는 가로로 밀어 볼 수 있어요. 세로 화면에서는 카드 보기가 편해요.</p>
        <div className="max-h-[60vh] overflow-auto rounded-lg border border-slate-500/20"><table className="w-full border-collapse text-sm"><thead className="sticky top-0 z-20"><tr><th className="min-w-48 bg-surface p-3 text-left">정보</th>{actors.map(actor => <th key={actor.name} className="min-w-48 bg-surface p-3">{actor.name}{actor.pc ? ' (PC)' : ''}</th>)}</tr></thead><tbody>{facts.slice(0, limit).map(fact => <tr key={fact.id} className="border-t border-slate-500/20"><th className="bg-surface p-3 text-left font-normal">{fact.secret && <span className="mr-1 text-amber-400">비밀</span>}{fact.text}</th>{actors.map(actor => { const value = relations.get(`${fact.id}\0${actor.name}`); return <td key={actor.name} className="align-top p-2"><button type="button" onClick={() => selectCell(fact, actor.name)} className="min-h-11 w-full rounded-lg bg-surface2 p-3 text-left"><span className="font-semibold">{knowledgeSymbol(value?.status)}</span><span className="mt-1 block whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-400">{value?.reason || '인지 근거 없음'}</span></button></td>; })}</tr>)}</tbody></table></div>
        {inspector}
      </>}
      {!loading && !facts.length && <p className="inu-help">아직 기록된 정보가 없어요. 정보 관리를 켜고 대화를 진행하면 기록돼요.</p>}
      {facts.length > limit && <button type="button" className="inu-button" onClick={() => setLimit(n => n + 100)}>정보 더 보기</button>}
      {context && <p className="inu-help">정보 관리 누적 비용 ${context.cost.toFixed(5)} · 입력 {context.inputTokens.toLocaleString()} / 출력 {context.outputTokens.toLocaleString()} 토큰</p>}

    </div>}
  </section>;
}
