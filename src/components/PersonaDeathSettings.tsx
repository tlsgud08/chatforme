import { useMemo, useState, type FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { deathStatusChoices, recordPersonaDeath } from '@/lib/personaDeath';
import type { PersonaDeathContext, PersonaDeathRecord } from '@/lib/personaDeathPrompt';
import { fetchMessagePage } from '@/lib/sessionData';
import type { Persona } from '@/types/db';
import InterfaceIcon from './InterfaceIcon';

interface Props {
  sessionId: string;
  currentPersona: Persona | undefined;
  nextPersonas: Persona[];
  deaths: PersonaDeathRecord[] | null;
  readError: boolean;
  busy: boolean;
  onRetry: () => void;
  onSavingChange: (saving: boolean) => boolean;
  onSaved: (context: PersonaDeathContext) => void;
}

const snapshotClass = 'm-0 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-3 text-xs [overflow-wrap:anywhere]';

function DeathForm({ sessionId, persona, nextPersonas, busy, onSavingChange, onSaved, onCancel }: {
  sessionId: string;
  persona: Persona;
  nextPersonas: Persona[];
  busy: boolean;
  onSavingChange: Props['onSavingChange'];
  onSaved: Props['onSaved'];
  onCancel: () => void;
}) {
  const [nextPersona, setNextPersona] = useState('');
  const [statusId, setStatusId] = useState('');
  const [note, setNote] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pages = useInfiniteQuery({
    queryKey: ['persona-death-status', sessionId],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) => fetchMessagePage(sessionId, pageParam, signal),
    getNextPageParam: page => page.hasOlder ? page.oldestTurn ?? undefined : undefined,
    refetchOnMount: 'always',
    gcTime: 0,
  });
  const choices = useMemo(() => pages.data?.pages.flatMap(page => deathStatusChoices(page.messages)) ?? [], [pages.data]);
  const status = choices.find(choice => choice.id === statusId);
  const disabled = saving || busy;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || (statusId && !status) || !onSavingChange(true)) return;
    setSaving(true);
    setError('');
    try {
      const context = await recordPersonaDeath(sessionId, persona.id, nextPersona || null, status, note, requestId);
      onSaved(context);
    } catch (error) {
      setError((error as { message?: string })?.message || '사망 기록을 저장하지 못했습니다.');
    } finally {
      setSaving(false);
      onSavingChange(false);
    }
  }

  return <form className="space-y-3" onSubmit={submit}>
    <div><p className="inu-field-label">{persona.name} · 사망 당시 페르소나 프롬프트</p><pre className={snapshotClass}>{persona.description}</pre></div>
    <label className="block space-y-1">
      <span className="inu-field-label">사망 당시 상태창</span>
      <select value={statusId} onChange={event => setStatusId(event.target.value)} disabled={disabled}>
        <option value="">상태창 없이 기록</option>
        {statusId && !status && <option value={statusId} disabled>선택한 코드블록을 다시 골라 주세요</option>}
        {choices.map(choice => <option key={choice.id} value={choice.id}>
          {choice.turn}턴 · {choice.label} · {choice.preview.trim().replace(/\s+/g, ' ').slice(0, 65)}
        </option>)}
      </select>
    </label>
    {status && <pre className={snapshotClass}>{status.preview}</pre>}
    {pages.isPending && <p className="inu-help" role="status">코드블록을 불러오는 중…</p>}
    {pages.isError && <p className="inu-help" role="alert">코드블록을 불러오지 못했습니다.</p>}
    {!pages.isPending && !pages.isError && !choices.length && <p className="inu-help">이 범위에 선택할 코드블록이 없습니다.</p>}
    <div className="flex flex-wrap gap-2">
      {pages.hasNextPage && <button type="button" className="inu-button" disabled={disabled || pages.isFetching} onClick={() => void pages.fetchNextPage()}>이전 대화 더 불러오기</button>}
      {(pages.isError || (error && statusId)) && <button type="button" className="inu-button" disabled={disabled || pages.isFetching} onClick={() => { setStatusId(''); void pages.refetch(); }}>코드블록 다시 불러오기</button>}
    </div>
    <label className="block space-y-1">
      <span className="inu-field-label">사망 메모</span>
      <textarea rows={3} value={note} onChange={event => setNote(event.target.value)} disabled={disabled} placeholder="사망 경위나 이후에도 남겨둘 내용을 기록하세요." />
    </label>
    <label className="block space-y-1">
      <span className="inu-field-label">다음 페르소나</span>
      <select value={nextPersona} onChange={event => setNextPersona(event.target.value)} disabled={disabled}>
        <option value="">나중에 선택</option>
        {nextPersonas.map(next => <option key={next.id} value={next.id}>{next.name}</option>)}
      </select>
    </label>
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="submit" className="inu-button inu-primary" disabled={disabled || (!!statusId && !status)}>{saving ? '저장 중…' : '사망 처리 저장'}</button>
      <button type="button" className="inu-button" disabled={saving} onClick={onCancel}>취소</button>
    </div>
  </form>;
}

export default function PersonaDeathSettings({ sessionId, currentPersona, nextPersonas, deaths, readError, busy, onRetry, onSavingChange, onSaved }: Props) {
  const [formPersonaId, setFormPersonaId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  return <details className="inu-section inu-accordion">
    <summary>
      <div><h3><InterfaceIcon name="my" />페르소나 사망 처리</h3>
        {deaths && <p className="inu-summary">사망한 페르소나 {deaths.length}명</p>}
      </div>
      <InterfaceIcon name="down" />
    </summary>
    <div className="inu-detail-body space-y-3">
      {readError ? <p role="alert" className="inu-help">사망 기록을 불러오지 못했습니다. <button type="button" className="inu-text-button" onClick={onRetry}>다시 불러오기</button></p>
        : deaths === null ? <p role="status" className="inu-help">사망 기록을 불러오는 중…</p> : <>
          {deaths.map(death => <details key={death.persona_id} className="rounded-lg border border-surface2 p-3">
            <summary className="cursor-pointer text-sm">{death.persona_name}</summary>
            <div className="mt-3 space-y-2">
              <p className="inu-field-label">페르소나 프롬프트</p><pre className={snapshotClass}>{death.persona_description}</pre>
              {death.status_block !== null && <><p className="inu-field-label">상태창</p><pre className={snapshotClass}>{death.status_block}</pre></>}
              {death.death_note.trim() && <><p className="inu-field-label">사망 메모</p><pre className={snapshotClass}>{death.death_note}</pre></>}
            </div>
          </details>)}
          {currentPersona && formPersonaId === currentPersona.id
            ? <DeathForm key={currentPersona.id} sessionId={sessionId} persona={currentPersona} nextPersonas={nextPersonas.filter(next => next.id !== currentPersona.id)}
                busy={busy} onSavingChange={onSavingChange} onCancel={() => setFormPersonaId(null)} onSaved={context => {
                  setMessage(currentPersona.name + '의 사망 기록을 저장했습니다.');
                  setFormPersonaId(null);
                  onSaved(context);
                }} />
            : currentPersona
              ? <button type="button" className="inu-button" disabled={busy} onClick={() => { setMessage(''); setFormPersonaId(currentPersona.id); }}>현재 페르소나 사망 처리</button>
              : <p className="inu-help">사망 처리할 페르소나를 먼저 선택해 주세요.</p>}
          {message && <p role="status" className="inu-help">{message}</p>}
        </>}
    </div>
  </details>;
}
