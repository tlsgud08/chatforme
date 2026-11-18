import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import AppUpdateNotice from './components/AppUpdateNotice';
import { AuthProvider } from './hooks/useAuth';
import { applyTheme, loadTheme } from './lib/theme';
import './index.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);

if (/^\/s\/[\da-f-]+\/?$/i.test(window.location.pathname) && document.getElementById('shared-scene-data')) {
  void import('./pages/SharedScenePage').then(({ default: SharedScenePage, readSharedScene, applyShareDisplay }) => {
    const scene = readSharedScene();
    if (scene) {
      applyShareDisplay(scene);
      root.render(<SharedScenePage scene={scene} />);
    }
  }).catch(error => console.error('Unable to load shared scene view', error));
} else {
  applyTheme(loadTheme() === 'dark' ? 'dark' : 'light');

  const queryClient = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
  });

  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <App />
            <AppUpdateNotice />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
