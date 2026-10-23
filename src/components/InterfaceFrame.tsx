import { useEffect, useMemo, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { canLeaveCurrentPage } from '@/lib/navigationGuard';
import {
  loadInterfaceDesign, subscribeInterfaceDesign,
  loadAppWidthLimited, loadChatWidthLimited, subscribeInterfaceWidth,
} from '@/lib/interfacePreference';
import InterfaceIcon, { type InterfaceIconName } from './InterfaceIcon';
import './InterfaceFrame.css';

const NAVIGATION: { to: string; label: string; icon: InterfaceIconName }[] = [
  { to: '/works', label: '작품', icon: 'works' },
  { to: '/sessions', label: '채팅방', icon: 'chat' },
  { to: '/create', label: '제작', icon: 'edit' },
  { to: '/settings', label: '설정', icon: 'settings' },
  { to: '/my', label: 'My', icon: 'my' },
];
type SidebarSession = { id: string; title: string; works: { title: string; thumbnail_url: string | null } | null };

export default function InterfaceFrame({ children }: { children: ReactNode }) {
  const design = useSyncExternalStore(subscribeInterfaceDesign, loadInterfaceDesign, () => 'modern' as const);
  const appWidthLimited = useSyncExternalStore(subscribeInterfaceWidth, loadAppWidthLimited, () => false);
  const chatWidthLimited = useSyncExternalStore(subscribeInterfaceWidth, loadChatWidthLimited, () => true);
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 920px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 920px)');
    const changed = () => setCollapsed(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  const { user } = useAuth();
  const userId = user?.id;
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const focusedView = /^\/(chat|multichat)\/(?!new(?:\/|$))/.test(pathname) ? 'chat'
    : /^\/create\/[^/]+/.test(pathname) ? 'editor' : undefined;
  const showNavigation = !!user && design === 'modern' && pathname !== '/login';
  const sidebarQuery = useMemo(() => ({
    queryKey: ['sessions', userId, 'sidebar'],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const { data, error } = await supabase.from('sessions')
        .select('id,title,works(title,thumbnail_url)')
        .eq('user_id', userId!).eq('is_archived', false)
        .order('updated_at', { ascending: false }).limit(8).abortSignal(signal);
      if (error) throw error;
      return (data as unknown as SidebarSession[]) ?? [];
    },
    enabled: showNavigation,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  }), [userId, showNavigation]);
  const { data: sessions, isError, isLoading, refetch } = useQuery(sidebarQuery);

  useEffect(() => {
    // Share in-flight reads and honor staleTime during route navigation.
    if (showNavigation) void queryClient.fetchQuery(sidebarQuery).catch(() => {});
  }, [pathname, showNavigation, queryClient, sidebarQuery]);

  async function guardedNavigate(event: MouseEvent<HTMLAnchorElement>, to: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (await canLeaveCurrentPage()) navigate(to);
  }

  function navigation(className: string) {
    return NAVIGATION.map(item => <NavLink key={item.to} to={item.to} aria-label={item.label} title={item.label}
      onClick={event => void guardedNavigate(event, item.to)}
      className={({ isActive }) => `${className} ${isActive || item.to === '/sessions' && /^\/(chat|multichat)\//.test(pathname) ? 'is-active' : ''}`}>
      <InterfaceIcon name={item.icon} /><span className="desktop-nav-label">{item.label}</span>
    </NavLink>);
  }

  return (
    <div className="interface-viewport" data-interface={design} data-app-width-limited={design === 'modern' && appWidthLimited || undefined}>
    <div className="interface-frame" data-interface={design} data-chat-width-limited={design === 'modern' && chatWidthLimited || undefined} data-focused-view={focusedView} data-login={!showNavigation || undefined} data-collapsed={collapsed || undefined}>
      {showNavigation && <>
        <header className="interface-topbar modern-only">
          <Link to="/works" onClick={event => void guardedNavigate(event, '/works')} className="interface-brand" aria-label="Inuchat 홈으로 이동">
            <img src="/logo-128.png" alt="" /><span>Inuchat</span>
          </Link>
          <Link to="/search" onClick={event => void guardedNavigate(event, '/search')} className="interface-search" aria-label="작품·유저 검색">
            <InterfaceIcon name="search" /><span>작품·유저 검색…</span>
          </Link>
          <div className="interface-topend">
            <Link to="/settings" onClick={event => void guardedNavigate(event, '/settings')} className="interface-icon-button" aria-label="화면 테마 설정" title="화면 테마 설정"><InterfaceIcon name="theme" /></Link>
            <Link to="/my" onClick={event => void guardedNavigate(event, '/my')} className="interface-avatar" aria-label="내 프로필">{(user?.user_metadata?.display_name || user?.email || 'I').slice(0, 1).toUpperCase()}</Link>
          </div>
        </header>
        <aside className="desktop-sidebar" aria-label="주요 메뉴">
          <nav className="desktop-navigation" aria-label="주요 화면">{navigation('desktop-nav-link')}</nav>
          <div className="desktop-recents">
            <div className="desktop-recents-heading"><span>최근 채팅방</span><Link to="/sessions" onClick={event => void guardedNavigate(event, '/sessions')} aria-label="모든 채팅방 보기"><InterfaceIcon name="next" /></Link></div>
            {isLoading && <p role="status" className="px-2 text-xs text-slate-500">불러오는 중…</p>}
            {isError && <button type="button" onClick={() => void refetch()} className="px-2 text-xs text-slate-400">다시 불러오기</button>}
            {!isError && !isLoading && sessions?.length === 0 && <p className="px-2 text-xs text-slate-500">진행 중인 채팅방이 없습니다.</p>}
            {sessions?.map(session => (
              <Link key={session.id} to={`/chat/${session.id}`}
                onClick={event => void guardedNavigate(event, `/chat/${session.id}`)}
                className={`desktop-session ${pathname === `/chat/${session.id}` ? 'is-active' : ''}`}>
                <span className="desktop-session-thumb" aria-hidden="true">{session.works?.thumbnail_url ? <img src={session.works.thumbnail_url} alt="" /> : (session.works?.title || session.title || '대화').slice(0, 2)}</span>
                <span className="desktop-session-text"><span>{session.title || session.works?.title || '채팅방'}</span><small>{session.works?.title || '대화 이어가기'}</small></span>
              </Link>
            ))}
          </div>
          <div className="desktop-sidebar-footer"><span>Inuchat</span><button type="button" onClick={() => setCollapsed(value => !value)} aria-label={collapsed ? '메뉴 펼치기' : '메뉴 접기'} aria-expanded={!collapsed} className="interface-icon-button"><InterfaceIcon name={collapsed ? 'expand' : 'collapse'} /></button></div>
        </aside>
        <nav className="interface-mobile-tabs modern-only" aria-label="모바일 주요 화면">{navigation('interface-mobile-link')}</nav>
      </>}
      <div className="interface-content">{children}</div>
    </div>
    </div>
  );
}
