import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { loadFriendSnapshot, type FriendRelationship } from '@/lib/friends';
import { editSemiExport, loadSemiContext, loadSemiLinks, semiAction, type SemiContext, type SemiLink, type SemiSnapshot } from '@/lib/semiSession';
import InterfaceIcon from './InterfaceIcon';
import { SessionMenuPage } from './SessionMenuFrame';

interface Props {
  sessionId: string; userId: string; busy: boolean;
  onPublish: (linkId: string) => Promise<boolean>;
  onSavingChange: (saving: boolean) => boolean;
  onActiveChange?: (active: boolean) => void;
}

export default function SemiSessionSettings({ sessionId, userId, busy, onPublish, onSavingChange, onActiveChange }: Props) {
  const [links, setLinks] = useState<SemiLink[]>([]), [friends, setFriends] = useState<FriendRelationship[]>([]);
  const [loaded, setLoaded] = useState(false), [saving, setSaving] = useState(false), [selected, setSelected] = useState('');
  const [error, setError] = useState(''), [status, setStatus] = useState(''), [reload, setReload] = useState(0);
  const lock = useRef(false), mounted = useRef(true);
  const [context, setContext] = useState<SemiContext | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [draft, setDraft] = useState<{ linkId: string; baseline: SemiSnapshot; content: string; name: string; description: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void loadFriendSnapshot(controller.signal).then(({ snapshot }) => {
      if (!controller.signal.aborted) setFriends(snapshot.relationships.filter(friend => friend.status === 'accepted'));
    }).catch(failure => { if (!controller.signal.aborted) setError((failure as Error).message); });
    return () => controller.abort();
  }, [userId]);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    async function refresh() {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const [rows, currentContext] = await Promise.all([loadSemiLinks(controller.signal), loadSemiContext(sessionId, controller.signal)]);
        if (!controller.signal.aborted) { setLinks(rows); setContext(currentContext); setLoaded(true); setError(''); }
      } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
      finally { inFlight = false; }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    const channel = supabase.channel(`semi-settings:${sessionId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'semi_session_links' }, focus).subscribe();
    return () => { controller.abort(); window.clearInterval(interval); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); void supabase.removeChannel(channel); };
  }, [sessionId, userId, reload]);

  const link = links.find(row => row.session_a === sessionId || row.session_b === sessionId);
  const active = link?.status === 'active';
  useEffect(() => { onActiveChange?.(active); }, [active, onActiveChange]);
  const incoming = links.filter(row => row.status === 'pending' && row.user_b === userId);
  const peer = context ? context.peer : link ? link.user_a === userId ? link.snapshot_b : link.snapshot_a : null;
  const peerPersona = context ? context.peer_persona : peer?.persona;
  const sent = link ? link.user_a === userId ? link.snapshot_a : link.snapshot_b : null;
  const peerName = (id: string) => friends.find(friend => friend.user_id === id)?.display_name || '친구';
  const disabled = busy || saving || !loaded;

  async function mutate(operation: 'request' | 'accept' | 'close', target?: SemiLink) {
    if (disabled || lock.current || !onSavingChange(true)) return;
    lock.current = true; setSaving(true); setError(''); setStatus('');
    try {
      await semiAction(operation, sessionId, target?.id, undefined, operation === 'request' ? selected : undefined);
      if (mounted.current) { setStatus(operation === 'request' ? '연결 요청을 보냈어요. 상대가 자신의 개인 채팅방에서 수락하면 연결돼요.' : operation === 'accept' ? '연결했어요. 요약 동기화로 내 정보를 보내 주세요.' : '연결을 해제했어요. 다음 AI 요청부터 상대 정보가 제외돼요.'); setReload(value => value + 1); }
    } catch (failure) { if (mounted.current) setError((failure as Error).message); }
    finally { lock.current = false; onSavingChange(false); if (mounted.current) setSaving(false); }
  }
  async function publish() {
    if (disabled || lock.current || !link) return;
    lock.current = true; setSaving(true); setError(''); setStatus('');
    try {
      const success = await onPublish(link.id);
      if (mounted.current) { if (success) setStatus('전달용 요약을 생성해 보냈어요. 내 요약 노트는 유지했어요.'); else setError('전달용 요약을 보내지 못했어요. 채팅방 오류 기록을 확인해 주세요.'); setReload(value => value + 1); }
    } catch (failure) { if (mounted.current) setError((failure as Error).message); }
    finally { lock.current = false; if (mounted.current) setSaving(false); }
  }

  async function saveExport() {
    if (!draft || disabled || lock.current || !onSavingChange(true)) return;
    lock.current = true; setSaving(true); setError(''); setStatus('');
    try {
      const updated = await editSemiExport(sessionId, draft.linkId, draft.baseline, draft.content, draft.name, draft.description);
      if (mounted.current) {
        setLinks(rows => rows.map(row => row.id !== draft.linkId ? row : { ...row, ...(row.user_a === userId ? { snapshot_a: updated } : { snapshot_b: updated }) }));
        setDraft(null); setStatus('전송 내용을 수정했어요. 상대의 다음 AI 요청부터 반영돼요.'); setReload(value => value + 1);
      }
    } catch (failure) { if (mounted.current) setError(`${(failure as Error).message} 편집 내용은 유지했어요.`); }
    finally { lock.current = false; onSavingChange(false); if (mounted.current) setSaving(false); }
  }

  return <><section className="inu-section" aria-label="세미 멀티챗 세션 연동">
    <h3><InterfaceIcon name="users" />세션 연동</h3>
    {!loaded && !error && <p className="inu-help">연결 정보를 불러오는 중…</p>}
    {link ? <>
      <p className="inu-help">{peerName(link.user_a === userId ? link.user_b : link.user_a)} · {link.user_a === userId ? link.title_b || '상대 세션 선택 대기' : link.title_a}</p>
      {link.status === 'active' ? <>
        <p className="inu-help" aria-live="polite">상대 세션 날짜 · {(link.user_a === userId ? link.sync_date_b : link.sync_date_a) || '아직 전달받은 날짜 없음'}</p>
        <p className="inu-help">PC2 페르소나: {peerPersona?.name || '페르소나 없음'}</p>
        <p className="inu-help">상대 마지막 전송: {peer ? new Date(peer.sent_at).toLocaleString('ko-KR') : '아직 없음'}</p>
        <button type="button" className="inu-button inu-full" onClick={() => setViewOpen(true)}>연동 정보 열람</button>
        <p className="inu-help">내 마지막 전송: {sent ? new Date(sent.sent_at).toLocaleString('ko-KR') : '아직 없음'}</p>
        <button type="button" className="inu-button inu-primary inu-full" disabled={disabled} onClick={() => void publish()}>{saving || busy ? '처리 중…' : '요약 생성하여 동기화'}</button>
        <p className="inu-help">내 요약 모델·API 키와 운영자의 동기화용 요약 프롬프트로 생성해 상대에게 보내요. 내 대화·요약 노트에는 반영하지 않으며, 생성 비용은 사용량에 기록돼요.</p>
      </> : <p className="inu-help">상대의 수락을 기다리고 있어요.</p>}
      <button type="button" className="inu-text-button" disabled={disabled} onClick={() => void mutate('close', link)}>{link.status === 'pending' ? '요청 취소' : '연결 해제'}</button>
    </> : loaded && <>
      {incoming.map(request => <div key={request.id} className="inu-detail-body">
        <p className="inu-help">{peerName(request.user_a)} · {request.title_a}에서 연결 요청</p>
        <div className="inu-two-fields"><button type="button" className="inu-button" disabled={disabled} onClick={() => void mutate('accept', request)}>이 채팅방과 연결</button><button type="button" className="inu-button" disabled={disabled} onClick={() => void mutate('close', request)}>거절</button></div>
      </div>)}
      <label className="inu-field-label" htmlFor="semi-friend">연결할 친구</label>
      <select id="semi-friend" value={selected} disabled={disabled} onChange={event => setSelected(event.target.value)}><option value="">친구 선택</option>{friends.map(friend => <option key={friend.user_id} value={friend.user_id}>{friend.display_name}</option>)}</select>
      <button type="button" className="inu-button inu-primary inu-full" disabled={disabled || !selected} onClick={() => void mutate('request')}>연결 요청</button>
      {!friends.length && <p className="inu-help">친구를 추가한 뒤 개인 채팅방을 연결할 수 있어요.</p>}
    </>}
    {error && <><p role="alert" className="inu-help text-red-400">{error}</p><button type="button" className="inu-text-button" disabled={saving} onClick={() => setReload(value => value + 1)}>다시 불러오기</button></>}
    {status && <p role="status" className="inu-help">{status}</p>}
  </section>
    {viewOpen && <SessionMenuPage enabled title="세션 연동 정보" onBack={() => setViewOpen(false)}>
      <div className="inu-summary-list">
        <button type="button" className="inu-button" disabled={saving} onClick={() => setReload(value => value + 1)}>새로 불러오기</button>
        {error && <p role="alert" className="inu-help">{error}</p>}
        {status && <p role="status" className="inu-help">{status}</p>}
        {link?.status === 'active' ? <>
          <section className="inu-section"><h3>받은 PC2 페르소나</h3><p>{peerPersona?.name || '페르소나 미선택'}</p><pre>{peerPersona?.description || '등록된 설명이 없어요.'}</pre><p className="inu-help">{peer?.persona_override ? '상대가 전송용으로 직접 편집한 페르소나예요.' : '상대가 현재 선택한 페르소나예요. 요약 전송 전에도 다음 AI 요청에 전달돼요.'}</p></section>
          <section className="inu-section"><h3>받은 PC2 세션 요약</h3>{peer ? <><p className="inu-help">요약 당시 인물: {peer.persona?.name || '페르소나 없음'} · {new Date(peer.sent_at).toLocaleString('ko-KR')}</p><pre>{peer.content}</pre></> : <p className="inu-help">상대가 아직 전달용 요약을 보내지 않았어요.</p>}</section>
          <section className="inu-section"><h3>내가 보낸 페르소나·요약</h3>{sent ? draft ? <>
            <label className="inu-field-label" htmlFor="semi-export-name">전송한 페르소나 이름</label><input id="semi-export-name" disabled={saving} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} />
            <label className="inu-field-label" htmlFor="semi-export-persona">전송한 페르소나 설명</label><textarea id="semi-export-persona" rows={5} disabled={saving} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} />
            <label className="inu-field-label" htmlFor="semi-export-summary">전송한 요약</label><textarea id="semi-export-summary" rows={14} disabled={saving} value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} />
            <p className="inu-help">상대에게 전달되는 내용만 수정해요. 원본 페르소나와 내 요약 노트는 유지돼요. 다시 요약을 생성하면 새 생성본으로 교체돼요.</p>
            <div className="inu-two-fields"><button type="button" className="inu-button inu-primary" disabled={disabled || !draft.content.trim()} onClick={() => void saveExport()}>{saving ? '저장 중…' : '전송 내용 저장'}</button><button type="button" className="inu-button" disabled={saving} onClick={() => setDraft(null)}>편집 취소</button></div>
          </> : <><p className="inu-help">{sent.persona?.name || '페르소나 없음'} · {new Date(sent.sent_at).toLocaleString('ko-KR')}{sent.edited_at ? ` · 수정 ${new Date(sent.edited_at).toLocaleString('ko-KR')}` : ''}</p><pre>{sent.persona?.description || '등록된 설명이 없어요.'}</pre><pre>{sent.content}</pre><button type="button" className="inu-button" disabled={disabled} onClick={() => setDraft({ linkId: link.id, baseline: sent, content: sent.content, name: sent.persona?.name ?? '', description: sent.persona?.description ?? '' })}>내 전송 내용 편집</button></> : <p className="inu-help">아직 전달용 요약을 보내지 않았어요.</p>}</section>
        </> : <p className="inu-help">연결이 해제되었어요. 상대 정보는 AI에게 전달되지 않아요.</p>}
      </div>
    </SessionMenuPage>}
  </>;
}
