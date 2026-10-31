import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { emptyState, knowledgeSymbol } from '@/lib/knowledge/core';
import { readKnowledgeContext, replayContext } from '@/lib/knowledge/runtime';
import type { Fact, Knowledge, KnowledgeContext } from '@/lib/knowledge/types';
import type { Session } from '@/types/db';
import Toggle from './Toggle';

export default function SessionInformationSettings({ session, busy, onUpdate }: { session: Session; busy: boolean; onUpdate: (patch: Partial<Session>) => void }) {
  const [open, setOpen] = useState(false), [context, setContext] = useState<KnowledgeContext | null>(null);
  const [message, setMessage] = useState(''), [saving, setSaving] = useState(false), [loading, setLoading] = useState(false);
  const [kind, setKind] = useState('all'), [search, setSearch] = useState(''), [limit, setLimit] = useState(100);
  const [inspect, setInspect] = useState<{ fact: Fact; actor: string; value?: Knowledge } | null>(null);
  const [status, setStatus] = useState<Knowledge['status']>('unknown'), [reason, setReason] = useState('');
  const request = useRef(0);
  const lock = useRef(false), route = useRef(session.id); route.current = session.id;
  async function refresh() {
    const id = session.id, sequence = ++request.current; setLoading(true); setMessage('');
    try { const value = await readKnowledgeContext(id); if (route.current === id && request.current === sequence) setContext(value); }
    catch (error) { if (route.current === id && request.current === sequence) setMessage((error as Error).message); }
    finally { if (route.current === id && request.current === sequence) setLoading(false); }
  }
  useEffect(() => { setContext(null); setInspect(null); if (open) void refresh(); return () => { request.current++; }; }, [session.id, open, busy, session.knowledge_revision]);
  useEffect(() => {
    if (!open) return;
    const listener = (event: Event) => { if ((event as CustomEvent<string>).detail === session.id) void refresh(); };
    window.addEventListener('inuchat:knowledge-updated', listener);
    return () => window.removeEventListener('inuchat:knowledge-updated', listener);
  }, [session.id, open]);
  useEffect(() => setLimit(100), [kind, search]);
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
  const facts = state.facts.filter(f => (kind === 'all' || f.kind === kind) && (!search || f.text.includes(search) || f.subjects.some(n => n.includes(search))));
  return <section className="inu-section">
    <h3>정보 접근 관리</h3>
    <label className="inu-switch-row inu-tall"><span>정보 접근 관리<small>인물별 O·△·X와 경위를 기록하고 메인 AI에 전달해요</small></span><Toggle aria-label="정보 접근 관리" checked={session.knowledge_enabled === true} disabled={busy || saving} onChange={knowledge => void toggle(knowledge)} /></label>
    <p className="inu-help">정보 관리를 끄면 기존 전송 방식을 그대로 사용해요. 변화 감지·기록 모델의 추가 비용이 발생할 수 있어요. 처음 켜면 기존 대화도 차례로 정리해요.</p>
    <button type="button" className="inu-button inu-full" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '정보표 닫기' : '정보표 열기'}</button>
    {message && <p role="status" className="inu-help">{message}</p>}
    {open && <div className="mt-3 flex min-w-0 flex-col gap-3">
      <p className="inu-help">O: 알고 있음 · △: 의심/오해 · X: 인지 근거 없음. 칸을 누르면 경위를 볼 수 있어요. 표에는 PC가 모르는 비밀도 포함돼요.</p>
      <div className="flex gap-2"><input aria-label="정보 검색" value={search} onChange={event => setSearch(event.target.value)} placeholder="정보 검색" /><button type="button" className="inu-button" disabled={loading} onClick={() => void refresh()}>{loading ? '조회 중…' : '새로고침'}</button></div>
      <select aria-label="정보 종류" value={kind} onChange={event => setKind(event.target.value)}><option value="all">전체 정보</option><option value="pc">PC 정보</option><option value="event">사건</option><option value="npc">NPC 정보</option></select>
      {replay.pending.length > 0 && <p role="status" className="inu-help">{replay.pending.filter(e => e.turn_index >= 0).length}개 응답의 정리가 필요해요. 다음 생성 전에 이어서 처리해요.</p>}
      <div className="max-h-[60vh] overflow-auto rounded-lg border border-slate-500/20"><table className="w-full border-collapse text-xs"><thead><tr><th className="sticky left-0 z-10 min-w-48 bg-surface p-3 text-left">정보</th>{state.actors.map(actor => <th key={actor.name} className="min-w-24 bg-surface p-3">{actor.name}{actor.pc ? ' (PC)' : ''}</th>)}</tr></thead><tbody>{facts.slice(0, limit).map(fact => <tr key={fact.id} className="border-t border-slate-500/20"><th className="sticky left-0 bg-surface p-3 text-left font-normal">{fact.secret && <span className="mr-1 text-amber-400">비밀</span>}{fact.text}</th>{state.actors.map(actor => { const value = relations.get(`${fact.id}\0${actor.name}`); return <td key={actor.name} className="p-2 text-center"><button type="button" aria-label={`${actor.name}: ${fact.text} — ${knowledgeSymbol(value?.status)}`} onClick={() => { setInspect({ fact, actor: actor.name, value }); setStatus(value?.status ?? 'unknown'); setReason(value?.reason ?? ''); }} className="min-h-10 min-w-10 rounded-lg bg-surface2 px-3 py-2 font-semibold">{knowledgeSymbol(value?.status)}</button></td>; })}</tr>)}</tbody></table></div>
      {!loading && !facts.length && <p className="inu-help">아직 기록된 정보가 없어요. 정보 관리를 켜고 대화를 진행하면 기록돼요.</p>}
      {facts.length > limit && <button type="button" className="inu-button" onClick={() => setLimit(n => n + 100)}>정보 더 보기</button>}
      {context && <p className="inu-help">정보 관리 누적 비용 ${context.cost.toFixed(5)} · 입력 {context.inputTokens.toLocaleString()} / 출력 {context.outputTokens.toLocaleString()} 토큰</p>}
      {inspect && <div className="rounded-lg border border-brand/30 p-3"><h4 className="font-semibold">{inspect.actor} — {inspect.fact.text}</h4><p className="my-2 whitespace-pre-wrap text-xs">{inspect.value?.reason || '알게 된 근거가 없어요.'}</p>{inspect.value?.quote && <blockquote className="my-2 whitespace-pre-wrap text-xs text-slate-400">{inspect.value.quote}</blockquote>}
        <select aria-label="인지 상태" value={status} disabled={!session.knowledge_enabled || busy || saving} onChange={event => setStatus(event.target.value as Knowledge['status'])}><option value="knows">O · 알고 있음</option><option value="suspects">△ · 의심</option><option value="believes">△ · 오해/소문을 믿음</option><option value="unknown">X · 모름</option></select>
        <textarea aria-label="인지 경위 정정" rows={3} value={reason} disabled={!session.knowledge_enabled || busy || saving} onChange={event => setReason(event.target.value)} placeholder="알게 된 경위 또는 실제로 의심·오해하는 내용" />
        <div className="mt-2 flex gap-2"><button type="button" className="inu-button inu-primary" disabled={!session.knowledge_enabled || busy || saving || !!replay.pending.length} onClick={() => void correct()}>정정 저장</button><button type="button" className="inu-button" onClick={() => setInspect(null)}>닫기</button></div>
      </div>}
    </div>}
  </section>;
}
