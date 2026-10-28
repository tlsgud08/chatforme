import { lazy, Suspense, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { isSupabaseConfigured } from './lib/supabase';
import Layout from './components/Layout';
import PageLoadBoundary from './components/PageLoadBoundary';
import SetupNotice from './components/SetupNotice';
import AppToast from './components/AppToast';
import AppConfirmDialog from './components/AppConfirmDialog';
import ThemeManager from './components/ThemeManager';
import InterfaceFrame from './components/InterfaceFrame';
import { FriendsProvider } from './hooks/useFriends';
import { FriendDialogs } from './components/Friends';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const WorksPage = lazy(() => import('./pages/WorksPage'));
const WorkDetailPage = lazy(() => import('./pages/WorkDetailPage'));
const SessionsPage = lazy(() => import('./pages/SessionsPage'));
const ChatPage = lazy(() => import('./pages/ChatPage'));
const CreatePage = lazy(() => import('./pages/CreatePage'));
const WorkEditorPage = lazy(() => import('./pages/WorkEditorPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const SearchPage = lazy(() => import('./pages/SearchPage'));
const MyPage = lazy(() => import('./pages/MyPage'));
const FavoritesPage = lazy(() => import('./pages/FavoritesPage'));
const UserPage = lazy(() => import('./pages/UserPage'));
const MultichatCreatePage = lazy(() => import('./pages/MultichatCreatePage'));
const MultichatPage = lazy(() => import('./pages/MultichatPage'));

function RouteContent({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  return <PageLoadBoundary resetKey={`${user?.id}:${pathname}`}>
    <Suspense fallback={<div className="flex h-full items-center justify-center text-slate-400" role="status">불러오는 중…</div>}>
      {children}
    </Suspense>
  </PageLoadBoundary>;
}

function ChatRoute() {
  const { sessionId } = useParams();
  const { user } = useAuth();
  return <ChatPage key={`${user?.id}:${sessionId}`} />;
}

function MultichatRoute() {
  const { roomId } = useParams();
  const { user } = useAuth();
  return <MultichatPage key={`${user?.id}:${roomId}`} />;
}

function WorkDetailRoute() {
  const { workId } = useParams();
  const { user } = useAuth();
  return <WorkDetailPage key={`${user?.id}:${workId}`} />;
}

function WorkEditorRoute() {
  const { workId } = useParams();
  const { user } = useAuth();
  return <WorkEditorPage key={`${user?.id}:${workId}`} />;
}

export default function App() {
  const { user, loading } = useAuth();

  if (!isSupabaseConfigured) return <SetupNotice />;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">불러오는 중…</div>
    );
  }

  if (!user) return <RouteContent><LoginPage /></RouteContent>;

  return (<FriendsProvider key={user.id} userId={user.id}>
    <AppToast />
    <AppConfirmDialog />
    <ThemeManager />
    <InterfaceFrame key={user.id}>
    <FriendDialogs />
    <Routes>
      <Route path="/login" element={<Navigate to="/works" replace />} />

      {/* 전체화면 (탭바 없음) */}
      <Route path="/chat/:sessionId" element={<RouteContent><ChatRoute /></RouteContent>} />
      <Route path="/search" element={<RouteContent><SearchPage /></RouteContent>} />
      <Route path="/multichat/new" element={<RouteContent><MultichatCreatePage /></RouteContent>} />
      <Route path="/multichat/:roomId" element={<RouteContent><MultichatRoute /></RouteContent>} />

      {/* 나머지는 탭바 레이아웃 */}
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/works" replace />} />
        <Route path="/works" element={<RouteContent><WorksPage /></RouteContent>} />
        <Route path="/works/:workId" element={<RouteContent><WorkDetailRoute /></RouteContent>} />
        <Route path="/sessions" element={<RouteContent><SessionsPage /></RouteContent>} />
        <Route path="/create" element={<RouteContent><CreatePage /></RouteContent>} />
        <Route path="/create/:workId" element={<RouteContent><WorkEditorRoute /></RouteContent>} />
        <Route path="/my" element={<RouteContent><MyPage /></RouteContent>} />
        <Route path="/settings" element={<RouteContent><SettingsPage /></RouteContent>} />
        <Route path="/favorites" element={<RouteContent><FavoritesPage /></RouteContent>} />
        <Route path="/users/:userId" element={<RouteContent><UserPage /></RouteContent>} />
        <Route path="*" element={<Navigate to="/works" replace />} />
      </Route>
    </Routes>
    </InterfaceFrame>
  </FriendsProvider>);
}
