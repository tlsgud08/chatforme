import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session as AuthSession, User } from '@supabase/supabase-js';
import { supabase, ADMIN_EMAIL } from '@/lib/supabase';
import { abortAccountTasks } from '@/lib/accountTasks';
import { stopCurrentFriendActivity } from '@/lib/friends';

interface AuthState {
  user: User | null;
  session: AuthSession | null;
  loading: boolean;
  isAdmin: boolean;
  canManageSettings: boolean;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string, masterPassword: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const accountId = useRef<string | null | undefined>(undefined);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingsAccess, setSettingsAccess] = useState<{ userId: string; allowed: boolean } | null>(null);

  useEffect(() => {
    let mounted = true;
    let authEvents = 0;
    const apply = (next: AuthSession | null) => {
      if (!mounted) return;
      if (accountId.current !== next?.user.id) {
        abortAccountTasks();
        queryClient.clear();
        accountId.current = next?.user.id;
      }
      setSession(next);
      setLoading(false);
    };
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      authEvents += 1;
      apply(s);
    });
    const eventAtRead = authEvents;
    void supabase.auth.getSession().then(({ data }) => {
      if (authEvents === eventAtRead) apply(data.session);
    }).catch(() => { if (authEvents === eventAtRead) apply(null); });
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, [queryClient]);

  const user = session?.user?.is_anonymous ? null : session?.user ?? null;
  const isAdmin = Boolean(user?.email && ADMIN_EMAIL && user.email === ADMIN_EMAIL);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    let sequence = 0;
    const refresh = async () => {
      const current = ++sequence;
      let allowed = false;
      try { const { data, error } = await supabase.rpc('is_settings_admin').abortSignal(controller.signal); allowed = !error && data === true; }
      catch { /* A missing/failed permission check never grants access. */ }
      if (!controller.signal.aborted && current === sequence) setSettingsAccess({ userId: user.id, allowed });
    };
    void refresh();
    window.addEventListener('focus', refresh);
    return () => { controller.abort(); window.removeEventListener('focus', refresh); };
  }, [user?.id]);
  const canManageSettings = isAdmin || (!!user && settingsAccess?.userId === user.id && settingsAccess.allowed);

  const value: AuthState = {
    user,
    session,
    loading,
    isAdmin,
    canManageSettings,
    async signInWithEmail(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    async signUpWithEmail(email, password, masterPassword) {
      const { data: allowed, error: verifyError } = await supabase.rpc('verify_signup_master_password', {
        candidate: masterPassword,
      });
      if (verifyError) throw verifyError;
      if (!allowed) throw new Error('마스터 비밀번호가 올바르지 않습니다.');
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
    },
    async signOut() {
      await stopCurrentFriendActivity();
      await supabase.auth.signOut();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
