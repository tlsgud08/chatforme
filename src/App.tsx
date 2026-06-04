import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { isSupabaseConfigured } from './lib/supabase';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import WorksPage from './pages/WorksPage';
import WorkDetailPage from './pages/WorkDetailPage';
import SessionsPage from './pages/SessionsPage';
import ChatPage from './pages/ChatPage';
import CreatePage from './pages/CreatePage';
import WorkEditorPage from './pages/WorkEditorPage';
import SettingsPage from './pages/SettingsPage';
import SearchPage from './pages/SearchPage';
import MyPage from './pages/MyPage';
import SetupNotice from './components/SetupNotice';
import FavoritesPage from './pages/FavoritesPage';
import UserPage from './pages/UserPage';

export default function App() {
  const { user, isGuest, loading } = useAuth();

  if (!isSupabaseConfigured) return <SetupNotice />;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">불러오는 중…</div>
    );
  }

  if (!user && !isGuest) return <LoginPage />;

  return (
    <Routes>
      {/* 로그인 화면 (CreatePage에서 로그인 유도 시 이동) */}
      <Route path="/login" element={<LoginPage />} />

      {/* 전체화면 (탭바 없음) */}
      <Route path="/chat/:sessionId" element={<ChatPage />} />
      <Route path="/search" element={<SearchPage />} />

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
  );
}
