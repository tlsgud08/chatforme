import { useMemo, useState, type FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { showConfirmDialog } from '@/lib/dialog';
import {
  deathStatusChoices, loadPersonaStatusTurn, mutatePersonaArchive, parsePersonaImageLink,
  type DeathStatusChoice, type StatusArchiveSelection,
} from '@/lib/personaDeath';
import { statusTurnLabel, type PersonaArchiveContext, type PersonaArchiveRecord } from '@/lib/personaDeathPrompt';
import { fetchMessagePage } from '@/lib/sessionData';
import type { Persona } from '@/types/db';
import InterfaceIcon from './InterfaceIcon';
import PersonaTransitionToggle from './PersonaTransitionToggle';

interface Props {
  sessionId: string;
  userId: string;
  onSelectPersona: (persona: Persona) => void;
  currentPersona: Persona | undefined;
  nextPersonas: Persona[];
  archives: PersonaArchiveRecord[] | null;
  readError: boolean;
  busy: boolean;
  onRetry: () => void;
  onSavingChange: (saving: boolean) => boolean;
  onSaved: (context: PersonaArchiveContext) => void;
}

const snapshotClass = 'm-0 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-3 text-xs [overflow-wrap:anywhere]';

function ArchiveForm({ sessionId, personaId, name, description, record, handoff = false, active = false, nextPersonas, busy, onSavingChange, onSaved, onCancel }: {
  sessionId: string;
  personaId: string;
  name: string;
  description: string;
  record?: PersonaArchiveRecord;
  handoff?: boolean;
  active?: boolean;
  nextPersonas: Persona[];
  busy: boolean;
  onSavingChange: Props['onSavingChange'];
  onSaved: Props['onSaved'];
  onCancel: () => void;
}) {
  const [nextPersona, setNextPersona] = useState('');
  const [statusId, setStatusId] = useState(record?.status_block != null ? 'keep' : '');
  const [turn, setTurn] = useState(record?.status_turn?.toString() ?? '');
  const [lookedUpStatus, setLookedUpStatus] = useState<DeathStatusChoice>();
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [note, setNote] = useState(record?.note ?? '');
  const [living, setLiving] = useState(record?.is_living ?? false);
  const [mayAppear, setMayAppear] = useState(record?.may_appear ?? false);
  const [imageLink, setImageLink] = useState(record?.image_url ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pages = useInfiniteQuery({
    queryKey: ['persona-archive-status', sessionId],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) => fetchMessagePage(sessionId, pageParam, signal),
    getNextPageParam: page => page.hasOlder ? page.oldestTurn ?? undefined : undefined,
    refetchOnMount: 'always',
    gcTime: 0,
  });
  const choices = useMemo(() => pages.data?.pages.flatMap(page => deathStatusChoices(page.messages)) ?? [], [pages.data]);
  const status = lookedUpStatus?.id === statusId ? lookedUpStatus : choices.find(choice => choice.id === statusId);
  const missingStatus = !!statusId && statusId !== 'keep' && !status;
  const disabled = saving || busy;

  async function selectTurn() {
    if (disabled || lookingUp) return;
    const number = Number(turn);
    if (!/^\d+$/.test(turn.trim()) || !Number.isInteger(number) || number > 2147483647) {
      setLookupError('0 이상의 턴 번호를 입력해 주세요.');
      return;
    }
    setLookingUp(true);
    setLookupError('');
    try {
      const choice = await loadPersonaStatusTurn(sessionId, number);
      if (!choice) {
        setLookupError(number + '턴에서 상태창으로 쓸 코드블록을 찾지 못했습니다.');
        return;
      }
      setLookedUpStatus(choice);
      setStatusId(choice.id);
    } catch (error) {
      setLookupError((error as { message?: string })?.message || '이 턴의 상태창을 불러오지 못했습니다.');
    } finally {
      setLookingUp(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || lookingUp || missingStatus) return;
    let imageUrl: string | null;
    try {
      imageUrl = living ? parsePersonaImageLink(imageLink) : null;
    } catch (error) {
      setError((error as Error).message);
      return;
    }
    if (!onSavingChange(true)) return;
    setSaving(true);
    setError('');
    const selection: StatusArchiveSelection = status
      ? { type: 'replace', status }
      : { type: statusId === 'keep' ? 'keep' : 'remove' };
    try {
      const context = await mutatePersonaArchive(sessionId, personaId, handoff ? 'create' : 'edit',
        nextPersona || null, record?.revision ?? null, crypto.randomUUID(),
        { living, mayAppear, imageUrl, note, status: selection });
      onSaved(context);
    } catch (error) {
      setError((error as { message?: string })?.message || '보관 기록을 저장하지 못했습니다.');
    } finally {
      setSaving(false);
      onSavingChange(false);
    }
  }

  return <form className="space-y-3" onSubmit={submit}>
    <div><p className="inu-field-label">{name} · 페르소나 프롬프트</p><pre className={snapshotClass}>{description}</pre></div>
    <label className="block space-y-1">
      <span className="inu-field-label">보관 상태</span>
      <select value={living ? 'living' : 'dead'} onChange={event => setLiving(event.target.value === 'living')} disabled={disabled}>
        <option value="dead" disabled={active && !handoff}>사망</option>
        <option value="living">생존</option>
      </select>
    </label>
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1 space-y-1">
        <span className="inu-field-label">상태창 기록</span>
        <select value={statusId} onChange={event => { setStatusId(event.target.value); setLookupError(''); }} disabled={disabled || lookingUp}>
          <option value="">상태창 없이 기록</option>
          {record?.status_block != null && <option value="keep">기존 {statusTurnLabel(record.status_turn)} 유지</option>}
          {missingStatus && <option value={statusId} disabled>선택한 코드블록을 다시 골라 주세요</option>}
          {lookedUpStatus && !choices.some(choice => choice.id === lookedUpStatus.id) &&
            <option value={lookedUpStatus.id}>{statusTurnLabel(lookedUpStatus.turn)} · {lookedUpStatus.label}</option>}
          {choices.map(choice => <option key={choice.id} value={choice.id}>
            {choice.turn}턴 · {choice.label} · {choice.preview.trim().replace(/\s+/g, ' ').slice(0, 65)}
          </option>)}
        </select>
      </label>
      <label className="w-20 space-y-1">
        <span className="inu-field-label">턴 번호</span>
        <input type="text" inputMode="numeric" value={turn} onChange={event => { setTurn(event.target.value); setLookupError(''); }}
          disabled={disabled || lookingUp} onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); void selectTurn(); }
          }} />
      </label>
      <button type="button" className="inu-button" disabled={disabled || lookingUp || !turn.trim()} onClick={() => void selectTurn()}>
        {lookingUp ? '찾는 중…' : '가져오기'}
      </button>
    </div>
    {lookupError && <p role="alert" className="inu-help">{lookupError}</p>}
    {status && <pre className={snapshotClass}>{status.preview}</pre>}
    {statusId === 'keep' && <pre className={snapshotClass}>{record?.status_block}</pre>}
    {(pages.hasNextPage || pages.isError) && <div className="flex flex-wrap gap-2">
      {pages.hasNextPage && <button type="button" className="inu-button" disabled={disabled || pages.isFetching} onClick={() => void pages.fetchNextPage()}>이전 대화 더 불러오기</button>}
      {pages.isError && <button type="button" className="inu-button" disabled={disabled || pages.isFetching} onClick={() => void pages.refetch()}>대화 다시 불러오기</button>}
    </div>}
    <label className="block space-y-1">
      <span className="inu-field-label">{living ? '보관 메모' : '사망 메모'}</span>
      <textarea rows={3} value={note} onChange={event => setNote(event.target.value)} disabled={disabled} />
    </label>
    {living && <>
      <label className="block space-y-1">
        <span className="inu-field-label">이미지 링크</span>
        <input type="url" inputMode="url" maxLength={2048} value={imageLink} onChange={event => setImageLink(event.target.value)}
          disabled={disabled} placeholder="https://" />
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" className="!w-auto" checked={mayAppear} onChange={event => setMayAppear(event.target.checked)} disabled={disabled} />
        <span>RP 중 등장 가능</span>
      </label>
    </>}
    {handoff && <label className="block space-y-1">
      <span className="inu-field-label">다음 페르소나</span>
      <select value={nextPersona} onChange={event => setNextPersona(event.target.value)} disabled={disabled}>
        <option value="">나중에 선택</option>
        {nextPersonas.map(next => <option key={next.id} value={next.id}>{next.name}</option>)}
      </select>
    </label>}
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="submit" className="inu-button inu-primary" disabled={disabled || lookingUp || missingStatus}>
        {saving ? '저장 중…' : handoff ? '보관 처리 저장' : '변경사항 저장'}
      </button>
      <button type="button" className="inu-button" disabled={saving} onClick={onCancel}>취소</button>
    </div>
  </form>;
}

export default function PersonaDeathSettings({ sessionId, userId, onSelectPersona, currentPersona, nextPersonas, archives, readError, busy, onRetry, onSavingChange, onSaved }: Props) {
  const [form, setForm] = useState<{ type: 'create' | 'edit'; personaId: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const record = form?.type === 'edit' ? archives?.find(item => item.persona_id === form.personaId) : undefined;
  const persona = form?.type === 'create' && currentPersona?.id === form.personaId ? currentPersona : undefined;
  const disabled = busy || deleting;

  function saved(context: PersonaArchiveContext, notice: string) {
    setForm(null);
    setMessage(notice);
    onSaved(context);
  }

  async function remove(record: PersonaArchiveRecord) {
    if (disabled) return;
    setDeleting(true);
    setDeleteError('');
    let locked = false;
    try {
      const confirmed = await showConfirmDialog(record.persona_name + '의 보관 기록을 삭제할까요?',
        '이 채팅방의 AI 문맥에서 보관 기록이 제거됩니다.', '삭제');
      if (!confirmed || !onSavingChange(true)) return;
      locked = true;
      const context = await mutatePersonaArchive(sessionId, record.persona_id, 'delete', null, record.revision, crypto.randomUUID());
      saved(context, '보관 기록을 삭제했습니다.');
    } catch (error) {
      setDeleteError((error as { message?: string })?.message || '보관 기록을 삭제하지 못했습니다.');
    } finally {
      setDeleting(false);
      if (locked) onSavingChange(false);
    }
  }

  return <details className="inu-section inu-accordion">
    <summary>
      <div><h3><InterfaceIcon name="my" />페르소나 보관 처리</h3>
        {archives && <p className="inu-summary">보관된 페르소나 {archives.length}명</p>}
      </div>
      <InterfaceIcon name="down" />
    </summary>
    <div className="inu-detail-body space-y-3">
      <PersonaTransitionToggle userId={userId} />
      {readError ? <p role="alert" className="inu-help">보관 기록을 불러오지 못했습니다. <button type="button" className="inu-text-button" onClick={onRetry}>다시 불러오기</button></p>
        : archives === null ? <p role="status" className="inu-help">보관 기록을 불러오는 중…</p> : <>
          {archives.map(item => {
            const selectable = item.is_living ? nextPersonas.find(candidate => candidate.id === item.persona_id) : undefined;
            const playing = currentPersona?.id === item.persona_id;
            return <details key={item.persona_id} className="rounded-lg border border-surface2 p-3">
              <summary className="cursor-pointer text-sm">
                {item.persona_name} · {item.is_living ? '생존' : '사망'}{playing ? ' · 플레이 중' : ''}{item.status_turn !== null ? ' · ' + statusTurnLabel(item.status_turn) : ''}
              </summary>
              <div className="mt-3 space-y-2">
                {record?.persona_id === item.persona_id
                  ? <ArchiveForm key={item.revision} sessionId={sessionId} personaId={item.persona_id} name={item.persona_name}
                      description={item.persona_description} record={item} active={playing} nextPersonas={[]} busy={disabled} onSavingChange={onSavingChange}
                      onCancel={() => setForm(null)} onSaved={context => saved(context, '보관 기록을 수정했습니다.')} />
                  : <>
                    <p className="inu-field-label">페르소나 프롬프트</p><pre className={snapshotClass}>{item.persona_description}</pre>
                    {item.status_block !== null && <><p className="inu-field-label">{statusTurnLabel(item.status_turn)}</p><pre className={snapshotClass}>{item.status_block}</pre></>}
                    {item.note.trim() && <><p className="inu-field-label">{item.is_living ? '보관 메모' : '사망 메모'}</p><pre className={snapshotClass}>{item.note}</pre></>}
                    {item.is_living && !playing && <p className="inu-help">NPC 등장 {item.may_appear ? '가능' : '불가'}</p>}
                    {item.image_url && <><p className="inu-field-label">이미지 링크</p><p className="break-all text-xs">{item.image_url}</p></>}
                    <div className="flex flex-wrap gap-2">
                      {selectable && !playing && <button type="button" className="inu-button" disabled={disabled} onClick={() => onSelectPersona(selectable)}>이 페르소나로 플레이</button>}
                      <button type="button" className="inu-button" disabled={disabled} onClick={() => { setMessage(''); setDeleteError(''); setForm({ type: 'edit', personaId: item.persona_id }); }}>편집</button>
                      <button type="button" className="inu-button" disabled={disabled} onClick={() => void remove(item)}>삭제</button>
                    </div>
                  </>}
              </div>
            </details>;
          })}
          {persona
            ? <ArchiveForm key={persona.id} sessionId={sessionId} personaId={persona.id} name={persona.name} description={persona.description} handoff
                record={archives.find(item => item.persona_id === persona.id)} nextPersonas={nextPersonas.filter(next => next.id !== persona.id)} busy={disabled} onSavingChange={onSavingChange}
                onCancel={() => setForm(null)} onSaved={context => saved(context, persona.name + '의 보관 기록을 저장했습니다.')} />
            : currentPersona
              ? <button type="button" className="inu-button" disabled={disabled} onClick={() => { setMessage(''); setDeleteError(''); setForm({ type: 'create', personaId: currentPersona.id }); }}>현재 페르소나 보관</button>
              : <p className="inu-help">보관할 페르소나를 먼저 선택해 주세요.</p>}
          {message && <p role="status" className="inu-help">{message}</p>}
          {deleteError && <p role="alert" className="text-xs text-red-300">{deleteError}</p>}
        </>}
    </div>
  </details>;
}
