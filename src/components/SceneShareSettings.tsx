import { useEffect, useId, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { showConfirmDialog } from '@/lib/dialog';
import { showToast } from '@/lib/toast';
import { sceneTurnLabel, type SharedScene } from '../lib/sceneShareView.js';
import { buildSceneShareCard } from '@/lib/sceneShareCard';
import { appliedCodeBlockStyle } from '@/lib/codeBlockStyles';
import { loadChatWidthLimited, loadInterfaceDesign } from '@/lib/interfacePreference';

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
  SCENE_THUMBNAIL_LOAD_FAILED: '작품 썸네일을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
  SCENE_CHANGED: '링크를 만드는 동안 장면이 바뀌었어요. 다시 시도해 주세요.',
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

export default function SceneShareSettings({ sessionId, latestTurn, sending, showImages }: {
  sessionId: string;
  latestTurn: number;
  sending: boolean;
  showImages: boolean;
}) {
  const linkId = useId();
  const [start, setStart] = useState(String(Math.max(latestTurn > 0 ? 1 : 0, latestTurn - 2)));
  const [end, setEnd] = useState(String(latestTurn));
  const [hideUser, setHideUser] = useState(true);
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

  function resetResult() {
    setPublishedLink(null);
    setError('');
  }

  async function publish() {
    if (busy || sending || !validRange) return;
    resetResult();
    setBusy(true);
    try {
      const result = await supabase.rpc('preview_scene_share', {
        p_session: sessionId, p_start: first, p_end: last, p_hide: hideUser,
      });
      if (result.error) throw result.error;
      const { scene, fingerprint } = result.data as PreparedScene;
      const root = document.documentElement;
      const display = {
        showImages,
        interfaceDesign: loadInterfaceDesign(),
        chatWidthLimited: loadChatWidthLimited(),
        codeBlockStyle: appliedCodeBlockStyle(),
        fontSize: root.dataset.chatFontSize === 'custom' ? parseFloat(root.style.getPropertyValue('--chat-font-size')) : null,
        fontWeight: parseFloat(root.style.getPropertyValue('--chat-font-weight')),
        boldWeight: parseFloat(root.style.getPropertyValue('--chat-bold-weight')),
      };
      const card = await buildSceneShareCard(scene);
      const published = await supabase.rpc('publish_scene_share_view', {
        p_session: sessionId, p_start: first, p_end: last, p_hide: hideUser, p_fingerprint: fingerprint,
        p_display: display, p_card: card,
      });
      if (published.error) throw published.error;
      setPublishedLink(published.data as PublishedSceneLink);
      setListRevision(revision => revision + 1);
    } catch (error) {
      setError(errorMessage(error as { message: string }));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(token: string) {
    if (busy) return;
    if (!await showConfirmDialog(
      '공유 링크 삭제',
      '삭제한 링크로는 장면을 읽을 수 없어요.',
      '링크 삭제',
    )) return;
    setError('');
    setBusy(true);
    const result = await supabase.rpc('revoke_scene_share', { p_session: sessionId, p_token: token });
    if (result.error) setError(errorMessage(result.error));
    else {
      if (publishedLink?.token === token) setPublishedLink(null);
      setLinks(previous => previous?.filter(link => link.token !== token) ?? previous);
      setListRevision(revision => revision + 1);
      showToast('장면 공유 링크를 삭제했어요.');
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
            onChange={event => { setStart(event.target.value); resetResult(); }} />
        </label>
        <label className="grid gap-1">끝 턴
          <input className="w-full rounded-lg border border-surface2 bg-surface px-3 py-2" type="number"
            min={0} max={latestTurn} step={1} value={end} disabled={busy}
            onChange={event => { setEnd(event.target.value); resetResult(); }} />
        </label>
      </div>
      <p className="inu-help">0–{latestTurn}턴 중 최대 {maximumTurns}턴 · 0턴은 첫 장면</p>
      <label className="my-2 flex items-center gap-2">
        <input type="checkbox" checked={hideUser} disabled={busy}
          onChange={event => { setHideUser(event.target.checked); resetResult(); }} />
        유저 대사 가리기
      </label>
      {hideUser && <p className="inu-help">AI 응답에 인용된 유저 대사는 공개될 수 있어요.</p>}
      <p className="inu-help">링크를 받은 사람은 로그인 없이 읽을 수 있어요. 링크는 처음 만든 시점부터 24시간 동안 열려요.</p>
      <button className="inu-button inu-full" type="button" disabled={busy || sending || !validRange}
        onClick={() => void publish()}>공유 링크 만들기</button>

      {publishedLink && <div className="grid gap-2">
        <p className="inu-help">만료 예정 <time dateTime={publishedLink.expiresAt}>{expiryFormat.format(new Date(publishedLink.expiresAt))}</time></p>
        <label className="sr-only" htmlFor={linkId}>공유 링크</label>
        <input id={linkId} className="w-full rounded-lg border border-surface2 bg-surface px-3 py-2" readOnly
          value={sceneUrl(publishedLink.token)} onFocus={event => event.target.select()} />
        <button className="inu-button inu-full" type="button" onClick={() => void copyLink(publishedLink.token)}>링크 복사</button>
      </div>}
    </section>

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
            onClick={() => void revoke(link.token)}>링크 삭제</button>
        </div>
      </div>)}
    </section>
  </>;
}
