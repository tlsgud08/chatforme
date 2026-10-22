import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { combinedWorkIds, type CombinationWorkInfo } from '@/lib/workCombination';
import { COMBINATION_SEARCH_PAGE_SIZE, WORK_COMBINATION_COLUMNS, fetchCombinationWorkInfo, saveWorkCombination, searchCombinationWorks } from '@/lib/workCombinationData';
import type { Session } from '@/types/db';
import { requestThemeRefresh } from '@/lib/theme';
import InterfaceIcon from './InterfaceIcon';
import Toggle from './Toggle';

interface Props {
  session: Session;
  userId: string;
  busy: boolean;
  onUpdate: (patch: Partial<Session>) => void;
  /** Synchronous parent lock also prevents sending before React re-renders. */
  onSavingChange: (saving: boolean) => boolean;
}

export default function SessionWorkCombinationSettings({ session, userId, busy, onUpdate, onSavingChange }: Props) {
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState<CombinationWorkInfo[]>([]);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [results, setResults] = useState<CombinationWorkInfo[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [reload, setReload] = useState(0);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const ids = session.combined_work_ids ?? [];
  const infoById = new Map(info.map(item => [item.id, item]));
  const selectedIds = new Set(ids);
  const enabled = session.work_combination_enabled === true;
  const disabled = busy || saving;

  useEffect(() => {
    const controller = new AbortController();
    setInfo([]);
    setInfoError('');
    setInfoLoading(true);
    void (async () => {
      try {
        const valid = combinedWorkIds(session.combined_work_ids, session.work_id);
        const rows = await fetchCombinationWorkInfo([session.work_id, ...valid], controller.signal);
        if (!controller.signal.aborted) setInfo(rows);
      } catch (failure) {
        if (!controller.signal.aborted) setInfoError(failure instanceof Error ? failure.message : '작품 정보를 불러오지 못했습니다.');
      } finally {
        if (!controller.signal.aborted) setInfoLoading(false);
      }
    })();
    return () => controller.abort();
  }, [session.work_id, session.combined_work_ids, reload]);

  useEffect(() => {
    const controller = new AbortController();
    setResults([]);
    setSearchError('');
    setSearchLoading(enabled && Boolean(search.trim()));
    if (!enabled || !search.trim()) return () => controller.abort();
    const timer = window.setTimeout(() => {
      void searchCombinationWorks(search, session.work_id, userId, page, controller.signal)
        .then(rows => { if (!controller.signal.aborted) setResults(rows); })
        .catch(failure => { if (!controller.signal.aborted) setSearchError(failure instanceof Error ? failure.message : '작품 검색에 실패했습니다.'); })
        .finally(() => { if (!controller.signal.aborted) setSearchLoading(false); });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [enabled, search, page, session.work_id, userId, reload]);

  async function save(nextEnabled: boolean, nextIds: string[]) {
    if (busy || lock.current || !onSavingChange(true)) return;
    lock.current = true;
    setSaving(true);
    setError('');
    setStatus('');
    try {
      const patch = await saveWorkCombination(session, userId, nextEnabled, nextIds);
      onUpdate(patch);
      requestThemeRefresh();
      if (mounted.current) setStatus('저장했습니다. 다음 채팅 요청부터 적용됩니다.');
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '설정을 저장하지 못했습니다.');
    } finally {
      lock.current = false;
      onSavingChange(false);
      if (mounted.current) setSaving(false);
    }
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[index], next[target]] = [next[target], next[index]];
    void save(enabled, next);
  }

  async function refresh() {
    if (busy || lock.current || !onSavingChange(true)) return;
    lock.current = true;
    setSaving(true);
    setError('');
    setStatus('');
    try {
      const { data, error: failure } = await supabase.from('sessions')
        .select(WORK_COMBINATION_COLUMNS).eq('id', session.id).eq('user_id', userId).single();
      if (failure || !data) throw new Error('설정을 불러오지 못했습니다. DB 업데이트와 접근 권한을 확인해 주세요.');
      onUpdate(data as Partial<Session>);
      requestThemeRefresh();
      if (mounted.current) setReload(value => value + 1);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '설정을 불러오지 못했습니다.');
    } finally {
      lock.current = false;
      onSavingChange(false);
      if (mounted.current) setSaving(false);
    }
  }

  return <section className="inu-section" aria-labelledby="session-work-combination-title" aria-busy={saving}>
    <div className="inu-row">
      <h3 id="session-work-combination-title"><InterfaceIcon name="merge" />작품 결합</h3>
      <Toggle aria-label="작품 결합 사용" checked={enabled} disabled={disabled} onChange={value => void save(value, ids)} />
    </div>
    <p className="inu-help">메인 작품이 최우선이에요. 추가 작품은 위에 있을수록 우선합니다.</p>
    <article className="inu-active-item">
      <span className="inu-help">메인 · 최우선 고정</span>
      <p className="break-words"><strong>{infoById.get(session.work_id)?.title || '현재 채팅방 작품'}</strong></p>
    </article>
    {ids.map((id, index) => <article className="inu-active-item" key={id}>
      <span className="inu-help">추가 {index + 1}순위{!enabled && ' · 적용 안 함'}</span>
      <p className="break-words"><strong>{infoById.has(id) ? infoById.get(id)?.title || '제목 없음' : infoLoading ? '불러오는 중…' : infoError ? '작품 정보 확인 실패' : '삭제되었거나 접근할 수 없는 작품'}</strong></p>
      <div className="inu-row">
        <div>
          <button type="button" className="inu-icon" aria-label={`추가 ${index + 1}순위 작품 우선순위 올리기`} disabled={disabled || index === 0} onClick={() => move(index, -1)}><InterfaceIcon name="send" /></button>
          <button type="button" className="inu-icon" aria-label={`추가 ${index + 1}순위 작품 우선순위 내리기`} disabled={disabled || index === ids.length - 1} onClick={() => move(index, 1)}><InterfaceIcon name="down" /></button>
        </div>
        <button type="button" className="inu-icon inu-danger" aria-label={`추가 ${index + 1}순위 작품 제거`} disabled={disabled} onClick={() => void save(enabled, ids.filter(item => item !== id))}><InterfaceIcon name="delete" /></button>
      </div>
    </article>)}
    {ids.length === 0 && <p className="inu-help">추가 작품이 없으면 기존 작품만 전달합니다.</p>}
    {!enabled && ids.length > 0 && <p className="inu-help">결합을 끄면 선택한 목록은 보관하고, 기존 작품만 전달합니다.</p>}
    {enabled && <>
      <label htmlFor="combination-work-search" className="inu-field-label">추가할 작품 검색</label>
      <input id="combination-work-search" type="search" value={search} disabled={disabled} placeholder="작품 이름 입력" onChange={event => { setSearch(event.target.value); setPage(0); }} />
      <div aria-live="polite">
        {searchLoading && <p className="inu-help">검색 중…</p>}
        {searchError && <p role="alert" className="inu-help">{searchError}</p>}
        {!searchLoading && !searchError && search.trim() && results.length === 0 && <p className="inu-help">검색 결과가 없습니다.</p>}
      </div>
      {results.map(item => <article className="inu-active-item" key={item.id}>
        <p className="break-words"><strong>{item.title || '제목 없음'}</strong></p>
        <p className="inu-help line-clamp-2">{item.description || '설명 없음'}</p>
        <button type="button" className="inu-button inu-outline inu-full" disabled={disabled || selectedIds.has(item.id) || searchLoading} onClick={() => void save(true, [...ids, item.id])}>
          <InterfaceIcon name={selectedIds.has(item.id) ? 'check' : 'plus'} />{selectedIds.has(item.id) ? '추가됨' : '작품 추가'}
        </button>
      </article>)}
      {search.trim() && <div className="inu-row">
        <button type="button" className="inu-text-button" disabled={disabled || searchLoading || page === 0} onClick={() => setPage(value => value - 1)}>이전</button>
        <span className="inu-help">{page + 1}페이지</span>
        <button type="button" className="inu-text-button" disabled={disabled || searchLoading || results.length < COMBINATION_SEARCH_PAGE_SIZE} onClick={() => setPage(value => value + 1)}>다음</button>
      </div>}
      <p className="inu-help">추가 작품의 메인 프롬프트와 작품 테마를 함께 사용해요. 작품 수와 프롬프트·테마 조건의 길이에 따라 입력 비용이 늘어납니다.</p>
    </>}
    {infoError && <p role="alert" className="inu-help">{infoError}</p>}
    {error && <p role="alert" className="inu-help">{error}</p>}
    {status && <p role="status" className="inu-help">{status}</p>}
    <button type="button" className="inu-text-button" disabled={disabled} onClick={() => void refresh()}><InterfaceIcon name="reroll" />설정 새로고침</button>
  </section>;
}
