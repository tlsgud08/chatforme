import { NavLink, Outlet, useNavigate } from 'react-router-dom';

const TABS = [
  { to: '/works', label: '작품', icon: '📚' },
  { to: '/sessions', label: '채팅방', icon: '💬' },
  { to: '/create', label: '제작', icon: '✏️' },
  { to: '/settings', label: '설정', icon: '⚙️' },
];

export default function Layout() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex h-full max-w-app flex-col bg-bg">
      {/* 상단바: 통합 검색 (Phase 2에서 실제 검색 연결) */}
      <header className="flex items-center gap-2 border-b border-surface2 px-4 py-3">
        <span className="text-lg font-bold text-white">Nekochat</span>
        <button
          onClick={() => navigate('/works')}
          className="ml-auto flex-1 rounded-full bg-surface px-4 py-2 text-left text-sm text-slate-400"
        >
          제작자 · 작품 검색…
        </button>
      </header>

      {/* 본문 */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>

      {/* 하단 탭바 */}
      <nav className="grid grid-cols-4 border-t border-surface2 bg-bg">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 py-2 text-xs ${
                isActive ? 'text-brand' : 'text-slate-400'
              }`
            }
          >
            <span className="text-xl">{t.icon}</span>
            {t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
