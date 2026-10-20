import { useEffect, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { canLeaveCurrentPage } from '@/lib/navigationGuard';
import { loadInterfaceDesign, subscribeInterfaceDesign } from '@/lib/interfacePreference';
import './InterfaceFrame.css';

const NAVIGATION = [
  { to: '/works', label: '작품', icon: '📚' },
  { to: '/sessions', label: '채팅방', icon: '💬' },
  { to: '/create', label: '제작', icon: '✏️' },
  { to: '/settings', label: '설정', icon: '⚙️' },
  { to: '/my', label: 'My', icon: '👤' },
];
type SidebarSession = { id: string; title: string; works: { title: string; thumbnail_url: string | null } | null };

function useDesktopViewport() {
  const [desktop, setDesktop] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)');
    const changed = () => setDesktop(query.matches);
    changed();
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  return desktop;
}

export default function InterfaceFrame({ children }: { children: ReactNode }) {
  const design = useSyncExternalStore(subscribeInterfaceDesign, loadInterfaceDesign, () => 'modern' as const);
  const desktop = useDesktopViewport();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const showNavigation = !!user && design === 'modern' && desktop && pathname !== '/login';
  const { data: sessions, isError, isLoading, refetch } = useQuery({
    queryKey: ['sessions', user?.id, 'sidebar'],
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.from('sessions')
        .select('id,title,works(title,thumbnail_url)')
        .eq('user_id', user!.id).eq('is_archived', false)
        .order('updated_at', { ascending: false }).limit(8).abortSignal(signal);
      if (error) throw error;
      return (data as unknown as SidebarSession[]) ?? [];
    },
    enabled: !!user && showNavigation,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  // Refresh after creating, renaming or branching a room on another route.
  useEffect(() => {
    if (showNavigation) void refetch();
  }, [pathname, showNavigation, refetch]);

  async function guardedNavigate(event: MouseEvent<HTMLAnchorElement>, to: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (await canLeaveCurrentPage()) navigate(to);
  }

  return (
    <div className="interface-frame" data-interface={design} data-login={pathname === '/login' || undefined}>
      <aside className="desktop-sidebar" aria-label="주요 메뉴">
        <Link to="/works" onClick={event => void guardedNavigate(event, '/works')} className="desktop-brand" aria-label="Inuchat 홈으로 이동">
          <img src="/logo-128.png" alt="" className="h-9 w-9 rounded-full object-cover" />
          <span>Inuchat</span>
        </Link>
        <Link to="/search" onClick={event => void guardedNavigate(event, '/search')} className="desktop-search" aria-label="작품·유저 검색">
          <span aria-hidden="true">🔍</span><span className="desktop-nav-label">작품·유저 검색</span>
        </Link>
        <nav className="desktop-navigation" aria-label="주요 화면">
          {NAVIGATION.map(item => (
            <NavLink key={item.to} to={item.to} aria-label={item.label}
              onClick={event => void guardedNavigate(event, item.to)}
              className={({ isActive }) => `desktop-nav-link ${isActive || item.to === '/sessions' && /^\/(chat|multichat)\//.test(pathname) ? 'is-active' : ''}`}>
              <span aria-hidden="true">{item.icon}</span><span className="desktop-nav-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="desktop-recents">
          <div className="mb-2 flex items-center justify-between px-2 text-xs text-slate-500">
            <span>채팅방</span>
            <Link to="/sessions" onClick={event => void guardedNavigate(event, '/sessions')} aria-label="모든 채팅방 보기">전체 보기</Link>
          </div>
          {isLoading && <p role="status" className="px-2 text-xs text-slate-500">불러오는 중…</p>}
          {isError && <button type="button" onClick={() => void refetch()} className="px-2 text-xs text-slate-400">다시 불러오기</button>}
          {!isError && !isLoading && sessions?.length === 0 && <p className="px-2 text-xs text-slate-500">진행 중인 채팅방이 없습니다.</p>}
          {sessions?.map(session => (
            <Link key={session.id} to={`/chat/${session.id}`}
              onClick={event => void guardedNavigate(event, `/chat/${session.id}`)}
              className={`desktop-session ${pathname === `/chat/${session.id}` ? 'is-active' : ''}`}>
              <span className="desktop-session-thumb" aria-hidden="true">{session.works?.thumbnail_url ? <img src={session.works.thumbnail_url} alt="" /> : '💬'}</span>
              <span className="line-clamp-2">{session.title || session.works?.title || '채팅방'}</span>
            </Link>
          ))}
        </div>
        <div className="desktop-sidebar-footer text-xs text-slate-500">Inuchat</div>
      </aside>
      <div className="interface-content">{children}</div>
    </div>
  );
}
