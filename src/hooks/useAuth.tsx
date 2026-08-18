import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session as AuthSession, User } from '@supabase/supabase-js';
import { supabase, ADMIN_EMAIL } from '@/lib/supabase';

interface AuthState {
  user: User | null;
  session: AuthSession | null;
  loading: boolean;
  isAdmin: boolean;
  isGuest: boolean;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string, masterPassword: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const isGuest = false;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const user = session?.user ?? null;
  const isAdmin = Boolean(user?.email && ADMIN_EMAIL && user.email === ADMIN_EMAIL);

  const value: AuthState = {
    user,
    session,
    loading,
    isAdmin,
    isGuest,
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
