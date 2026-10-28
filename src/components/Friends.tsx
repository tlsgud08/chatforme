import { useEffect, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFriends } from '@/hooks/useFriends';
import { friendActivityLabel, friendActivityDescription, friendPresenceLabel, type FriendOperation, type FriendView } from '@/lib/friends';
import { showToast } from '@/lib/toast';
import { showConfirmDialog } from '@/lib/dialog';
import InterfaceIcon from './InterfaceIcon';
import './Friends.css';

async function attempt(operation: () => Promise<void>) {
  try { await operation(); } catch (error) { showToast((error as Error).message || '친구 정보를 저장하지 못했습니다.'); }
}
export function FriendAvatar({ friend, small = false }: { friend: FriendView; small?: boolean }) {
  return <span className={`friend-avatar${small ? ' friend-avatar-small' : ''}`}>
    {friend.avatar_url ? <img src={friend.avatar_url} alt="" /> : <span>{friend.display_name?.[0] || '?'}</span>}
    <span className={`friend-presence-dot friend-presence-${friend.presence}`} />
  </span>;
}
export function FriendActivityStrip() {
  const social = useFriends();
  if (!social) return null;
  return <div className="friend-activity-strip" aria-label="친구 활동">
    <div className="friend-activity-people">
      {social.friends.map(friend => <button key={friend.user_id} type="button" className="friend-activity-person" onClick={() => social.openProfile(friend.user_id)} aria-label={`${friend.display_name} · ${friendActivityDescription(friend, social.works)}`}>
        <FriendAvatar friend={friend} /><span className="friend-activity-copy"><span className="friend-activity-name">{friend.display_name || '(이름 없음)'}</span><span className="friend-activity-caption">{friendActivityLabel(friend, social.works)}</span></span>
      </button>)}
      {!social.friends.length && <button type="button" className="friend-empty-link" onClick={() => social.openManager(true)}>{social.loading ? '친구 활동을 불러오는 중…' : social.error ? '친구 상태를 확인해 주세요' : '친구를 추가해 플레이 소식을 확인하세요'}</button>}
    </div>
    <button type="button" className="friend-manage-button" aria-label="친구 관리" onClick={() => social.openManager(true)}><InterfaceIcon name="users" />{social.relationships.some(row => row.status === 'pending' && row.requested_by !== social.userId) && <span className="friend-request-dot" />}</button>
  </div>;
}
export function SameWorkFriends({ workId }: { workId: string | null | undefined }) {
  const social = useFriends();
  const friends = social?.friends.filter(friend => !!workId && friend.currentWorkId === workId && friend.currentActivityType === 'play' && (friend.presence === 'online' || friend.presence === 'away')) ?? [];
  if (!friends.length || !social) return null;
  return <div className="same-work-friends" aria-label="같은 작품을 플레이 중인 친구">
    {friends.slice(0, 3).map(friend => <button key={friend.user_id} type="button" onClick={() => social.openProfile(friend.user_id)} aria-label={`${friend.display_name} · ${friendPresenceLabel(friend)} · 같은 작품 플레이 중`}><FriendAvatar friend={friend} small /></button>)}
    {friends.length > 3 && <button type="button" onClick={() => social.openManager(true)} aria-label="같은 작품의 친구 더 보기">+{friends.length - 3}</button>}
  </div>;
}
export function FriendshipActions({ userId }: { userId: string }) {
  const social = useFriends();
  if (!social || userId === social.userId) return null;
  const relation = social.relationships.find(row => row.user_id === userId);
  const run = (operation: FriendOperation) => void attempt(async () => {
    if (operation === 'remove' && !await showConfirmDialog('친구를 삭제할까요?', '서로의 접속·플레이 활동 공유가 종료됩니다.', '삭제')) return;
    await social.change(userId, operation);
  });
  const button = (operation: FriendOperation, label: string) => <button key={operation} type="button" disabled={social.pending || social.loading} onClick={() => run(operation)} className={`friend-action${operation === 'request' || operation === 'accept' ? ' friend-action-primary' : ''}`}>{label}</button>;
  return <div className="friendship-actions">
    {!relation && button('request', '친구 추가')}
    {relation?.status === 'accepted' && <><span className="text-xs text-slate-400">친구</span>{button('remove', '친구 삭제')}</>}
    {relation?.status === 'pending' && (relation.requested_by === social.userId ? button('cancel', '친구 요청 취소') : <>{button('accept', '친구 요청 수락')}{button('reject', '거절')}</>)}
  </div>;
}
export function FriendsEntry() {
  const social = useFriends();
  if (!social) return null;
  const count = social.relationships.filter(row => row.status === 'pending' && row.requested_by !== social.userId).length;
  return <button type="button" className="friends-entry" onClick={() => social.openManager(true)}><InterfaceIcon name="users" /><span>친구 관리</span><span>{social.friends.length}명{count ? ` · 받은 요청 ${count}개` : ''}</span><InterfaceIcon name="next" /></button>;
}
function FriendModal({ label, close, children }: { label: string; close: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (document.activeElement && !panel.current?.contains(document.activeElement)) return;
      if (event.key === 'Escape') { event.stopPropagation(); closeRef.current(); }
      if (event.key === 'Tab') {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]') ?? [])];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="friend-modal-backdrop" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={panel} className="friend-modal" role="dialog" aria-modal="true" aria-label={label}>
      <header><h2>{label}</h2><button type="button" aria-label={`${label} 닫기`} onClick={close}><InterfaceIcon name="close" /></button></header>{children}
    </div>
  </div>;
}
export function FriendDialogs() {
  const social = useFriends(), navigate = useNavigate();
  if (!social) return null;
  const friend = social.friends.find(value => value.user_id === social.profileId);
  const work = friend?.displayWorkId ? social.works[friend.displayWorkId] : null;
  const requests = social.relationships.filter(row => row.status === 'pending');
  return <>
    {friend && <FriendModal label="친구 활동" close={() => social.openProfile(null)}>
      <div className="friend-profile-identity"><FriendAvatar friend={friend} /><div><h3>{friend.display_name || '(이름 없음)'}</h3><p>{friendPresenceLabel(friend)}</p></div></div>
      <div className="friend-profile-activity">{work?.thumbnail_url && <img src={work.thumbnail_url} alt="" />}<span>{friendActivityLabel(friend, social.works)}</span></div>
      <div className="friend-profile-actions">{work && <button type="button" className="friend-action friend-action-primary" onClick={() => { social.openProfile(null); social.openManager(false); navigate(`/works/${work.id}`); }}>작품 보기</button>}<button type="button" className="friend-action" onClick={() => { social.openProfile(null); social.openManager(false); navigate(`/users/${friend.user_id}`); }}>프로필 보기</button></div>
    </FriendModal>}
    {social.managerOpen && !friend && <FriendModal label="친구 관리" close={() => social.openManager(false)}>
      <button type="button" className="friend-action friend-action-primary w-full" onClick={() => { social.openManager(false); navigate('/search?tab=users'); }}>유저 검색 · 친구 추가</button>
      <label className="friend-sharing"><input type="checkbox" checked={social.sharing} disabled={social.pending || social.loading} onChange={event => void attempt(() => social.setSharing(event.target.checked))} /><span>내 접속·플레이 활동 공유<small>친구에게만 표시돼요.</small></span></label>
      {social.error && <p role="alert" className="friend-load-error">친구 정보를 불러오지 못했어요. <button type="button" onClick={() => void social.refresh()}>다시 시도</button></p>}
      {requests.length > 0 && <section className="friend-manager-section"><h3>친구 요청</h3>{requests.map(request => <div key={request.user_id} className="friend-manager-request"><span>{request.display_name || '(이름 없음)'}<small>{request.requested_by === social.userId ? '보낸 요청' : '받은 요청'}</small></span><FriendshipActions userId={request.user_id} /></div>)}</section>}
      <section className="friend-manager-section"><h3>친구 {social.friends.length}명</h3>{social.friends.map(person => <div key={person.user_id} className="friend-manager-row"><button type="button" className="friend-activity-person" onClick={() => social.openProfile(person.user_id)}><FriendAvatar friend={person} /><span className="friend-activity-copy"><span className="friend-activity-name">{person.display_name}</span><span className="friend-activity-caption">{friendActivityLabel(person, social.works)}</span></span></button><FriendshipActions userId={person.user_id} /></div>)}{!social.friends.length && <p className="text-sm text-slate-400">등록한 친구가 없어요.</p>}</section>
    </FriendModal>}
  </>;
}
