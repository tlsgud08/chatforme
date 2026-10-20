import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { isSupabaseConfigured } from './lib/supabase';
import Layout from './components/Layout';
import PageLoadBoundary from './components/PageLoadBoundary';
import SetupNotice from './components/SetupNotice';
import AppToast from './components/AppToast';
import AppConfirmDialog from './components/AppConfirmDialog';
import ThemeManager from './components/ThemeManager';
import InterfaceFrame from './components/InterfaceFrame';

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

export default function App() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const fallback = <div className="flex h-full items-center justify-center text-slate-400" role="status">불러오는 중…</div>;

  if (!isSupabaseConfigured) return <SetupNotice />;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">불러오는 중…</div>
    );
  }

  if (!user) return <PageLoadBoundary resetKey={location.pathname}><Suspense fallback={fallback}><LoginPage /></Suspense></PageLoadBoundary>;

  return (<>
    <AppToast />
    <AppConfirmDialog />
    <ThemeManager />
    <PageLoadBoundary resetKey={location.pathname}>
    <Suspense fallback={fallback}>
    <InterfaceFrame>
    <Routes>
      {/* 로그인 화면 (CreatePage에서 로그인 유도 시 이동) */}
      <Route path="/login" element={<LoginPage />} />

      {/* 전체화면 (탭바 없음) */}
      <Route path="/chat/:sessionId" element={<ChatPage />} />
      <Route path="/search" element={<SearchPage />} />
      <Route path="/multichat/new" element={<MultichatCreatePage />} />
      <Route path="/multichat/:roomId" element={<MultichatPage />} />

      {/* 나머지는 탭바 레이아웃 */}
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/works" replace />} />
        <Route path="/works" element={<WorksPage />} />
        <Route path="/works/:workId" element={<WorkDetailPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/create" element={<CreatePage />} />
        <Route path="/create/:workId" element={<WorkEditorPage />} />
        <Route path="/my" element={<MyPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/favorites" element={<FavoritesPage />} />
        <Route path="/users/:userId" element={<UserPage />} />
        <Route path="*" element={<Navigate to="/works" replace />} />
      </Route>
    </Routes>
    </InterfaceFrame>
    </Suspense>
    </PageLoadBoundary>
  </>);
}
