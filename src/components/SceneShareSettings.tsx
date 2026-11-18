import { useEffect, useId, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { showConfirmDialog } from '@/lib/dialog';
import { showToast } from '@/lib/toast';
import SharedSceneContent, { sceneTurnLabel, type SharedScene } from '../lib/sceneShareView.js';

interface PreparedScene {
  scene: SharedScene;
  fingerprint: string;
}

interface PublishedSceneLink {
  token: string;
  expiresAt: string;
}

interface SceneLink extends PublishedSceneLink {
  start: number;
  end: number;
  hideUser: boolean;
}

const maximumTurns = 20;
const sceneErrors: Record<string, string> = {
  SCENE_INVALID_RANGE: '공유할 턴 범위를 다시 확인해 주세요.',
  SCENE_NOT_FOUND: '이 채팅방은 공유할 수 없어요.',
  SCENE_STREAMING: '이 장면의 응답 생성이 끝난 뒤 다시 시도해 주세요.',
  SCENE_EMPTY: '선택한 구간에 공개할 내용이 없어요.',
  SCENE_TOO_LARGE: '장면 내용이 너무 길어요. 공유할 턴 범위를 줄여 주세요.',
  SCENE_CHANGED: '미리보기 이후 장면이 바뀌었어요. 다시 미리 봐 주세요.',
};

function errorMessage(error: { message: string }) {
  return sceneErrors[error.message] ?? '장면 공유 요청에 실패했어요. 다시 시도해 주세요.';
}

const expiryFormat = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function sceneUrl(token: string) {
  return new URL('/s/' + token, window.location.origin).href;
}

async function copyLink(token: string) {
  try {
    await navigator.clipboard.writeText(sceneUrl(token));
    showToast('장면 공유 링크를 복사했어요.');
  } catch {
    showToast('자동 복사가 안 됐어요. 표시된 링크를 직접 복사해 주세요.');
  }
}

export default function SceneShareSettings({ sessionId, latestTurn, sending }: {
  sessionId: string;
  latestTurn: number;
  sending: boolean;
}) {
  const linkId = useId();
  const [start, setStart] = useState(String(Math.max(latestTurn > 0 ? 1 : 0, latestTurn - 2)));
  const [end, setEnd] = useState(String(latestTurn));
  const [hideUser, setHideUser] = useState(true);
  const [prepared, setPrepared] = useState<PreparedScene | null>(null);
  const [publishedLink, setPublishedLink] = useState<PublishedSceneLink | null>(null);
  const [links, setLinks] = useState<SceneLink[] | null>(null);
  const [linksError, setLinksError] = useState(false);
  const [listRevision, setListRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLinksError(false);
    void (async () => {
      const result = await supabase.rpc('list_scene_shares', { p_session: sessionId }).abortSignal(controller.signal);
      if (controller.signal.aborted) return;
      if (result.error) setLinksError(true);
      else setLinks((result.data ?? []) as SceneLink[]);
    })();
    return () => controller.abort();
  }, [listRevision, sessionId]);

  const first = Number(start);
  const last = Number(end);
  const validRange = /^\d+$/.test(start) && /^\d+$/.test(end) &&
    Number.isSafeInteger(first) && Number.isSafeInteger(last) &&
    first <= last && last <= latestTurn && last - first < maximumTurns;

  function resetPreview() {
    setPrepared(null);
    setPublishedLink(null);
    setError('');
  }

  async function preview() {
    if (busy || sending || !validRange) return;
    resetPreview();
    setBusy(true);
    const result = await supabase.rpc('preview_scene_share', {
      p_session: sessionId, p_start: first, p_end: last, p_hide: hideUser,
    });
    if (result.error) setError(errorMessage(result.error));
    else setPrepared(result.data as PreparedScene);
    setBusy(false);
  }

  async function publish() {
    if (busy || sending || !prepared) return;
    setError('');
    setBusy(true);
    const result = await supabase.rpc('publish_scene_share', {
      p_session: sessionId,
      p_start: prepared.scene.start,
      p_end: prepared.scene.end,
      p_hide: prepared.scene.hideUser,
      p_fingerprint: prepared.fingerprint,
    });
    if (result.error) {
      if (result.error.message === 'SCENE_CHANGED') setPrepared(null);
      setError(errorMessage(result.error));
    } else if (result.data?.token) {
      setPublishedLink(result.data as PublishedSceneLink);
      setListRevision(revision => revision + 1);
    }
    setBusy(false);
  }

  async function revoke(token: string) {
    if (busy) return;
    if (!await showConfirmDialog(
      '공유 링크 끄기',
      '이 링크로 장면을 읽을 수 없게 됩니다. 계속할까요?',
      '링크 끄기',
    )) return;
    setError('');
    setBusy(true);
    const result = await supabase.rpc('revoke_scene_share', { p_session: sessionId, p_token: token });
    if (result.error) setError(errorMessage(result.error));
    else {
      if (publishedLink?.token === token) setPublishedLink(null);
      setLinks(previous => previous?.filter(link => link.token !== token) ?? previous);
      setListRevision(revision => revision + 1);
      showToast('장면 공유 링크를 껐어요.');
    }
    setBusy(false);
  }

  return <>
    <section className="inu-section">
      <h3>공유할 턴</h3>
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1">시작 턴
          <input className="w-full rounded-lg border border-surface2 bg-surface px-3 py-2" type="number"
            min={0} max={latestTurn} step={1} value={start} disabled={busy}
            onChange={event => { setStart(event.target.value); resetPreview(); }} />
        </label>
        <label className="grid gap-1">끝 턴
          <input className="w-full rounded-lg border border-surface2 bg-surface px-3 py-2" type="number"
            min={0} max={latestTurn} step={1} value={end} disabled={busy}
            onChange={event => { setEnd(event.target.value); resetPreview(); }} />
        </label>
      </div>
      <p className="inu-help">0–{latestTurn}턴 중 최대 {maximumTurns}턴 · 0턴은 첫 장면</p>
      <label className="my-2 flex items-center gap-2">
        <input type="checkbox" checked={hideUser} disabled={busy}
          onChange={event => { setHideUser(event.target.checked); resetPreview(); }} />
        유저 대사 가리기
      </label>
      <button className="inu-button inu-full" type="button" disabled={busy || sending || !validRange}
        onClick={() => void preview()}>장면 미리보기</button>
    </section>

    {prepared && <section className="inu-section">
      <link rel="stylesheet" href="/scene-share.css" />
      <h3>{prepared.scene.title} · {sceneTurnLabel(prepared.scene.start, prepared.scene.end)}</h3>
      {prepared.scene.hideUser && <p className="inu-help">AI 응답에 인용된 유저 대사는 공개될 수 있어요.</p>}
      <div className="shared-scene-preview"><SharedSceneContent scene={prepared.scene} /></div>
      <p className="inu-help">링크를 받은 사람은 로그인 없이 읽을 수 있어요. 링크는 처음 만든 시점부터 24시간 동안 열려요.</p>
      {!publishedLink && <button className="inu-button inu-full" type="button" disabled={busy || sending}
        onClick={() => void publish()}>공유 링크 만들기</button>}
      {publishedLink && <div className="grid gap-2">
        <p className="inu-help">만료 예정 <time dateTime={publishedLink.expiresAt}>{expiryFormat.format(new Date(publishedLink.expiresAt))}</time></p>
        <label className="sr-only" htmlFor={linkId}>공유 링크</label>
        <input id={linkId} className="w-full rounded-lg border border-surface2 bg-surface px-3 py-2" readOnly
          value={sceneUrl(publishedLink.token)} onFocus={event => event.target.select()} />
        <button className="inu-button inu-full" type="button" onClick={() => void copyLink(publishedLink.token)}>링크 복사</button>
      </div>}
    </section>}

    {error && <p role="alert" className="inu-help text-amber-300">{error}</p>}
    {busy && <p role="status" className="inu-help">처리 중…</p>}

    <section className="inu-section">
      <h3>기존 공유 링크</h3>
      {linksError
        ? <button type="button" className="inu-text-button" onClick={() => setListRevision(revision => revision + 1)}>링크 목록 다시 불러오기</button>
        : links === null
          ? <p className="inu-help">불러오는 중…</p>
          : !links.length && <p className="inu-help">공유 중인 장면이 없어요.</p>}
      {links?.map(link => <div key={link.token} className="grid gap-1 border-t border-surface2 py-3">
        <p>{sceneTurnLabel(link.start, link.end)} · {link.hideUser ? '유저 대사 가림' : '유저 대사 공개'}</p>
        <p className="inu-help">만료 예정 <time dateTime={link.expiresAt}>{expiryFormat.format(new Date(link.expiresAt))}</time></p>
        <input aria-label={sceneTurnLabel(link.start, link.end) + ' 공유 링크'}
          className="w-full rounded-lg border border-surface2 bg-surface px-3 py-2 text-sm" readOnly
          value={sceneUrl(link.token)} onFocus={event => event.target.select()} />
        <div className="flex flex-wrap gap-3">
          <a className="inu-text-button" href={sceneUrl(link.token)} target="_blank" rel="noreferrer">장면 열기</a>
          <button className="inu-text-button" type="button" onClick={() => void copyLink(link.token)}>복사</button>
          <button className="inu-text-button inu-danger" type="button" disabled={busy}
            onClick={() => void revoke(link.token)}>끄기</button>
        </div>
      </div>)}
    </section>
  </>;
}
