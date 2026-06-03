import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session as AuthSession, User } from '@supabase/supabase-js';
import { supabase, ADMIN_EMAIL } from '@/lib/supabase';

const GUEST_KEY = 'nekochat.guest';

interface AuthState {
  user: User | null;
  session: AuthSession | null;
  loading: boolean;
  isAdmin: boolean;
  isGuest: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  enterGuest: () => void;
  exitGuest: () => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [isGuest, setIsGuest] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(GUEST_KEY) === '1') {
      setIsGuest(true);
      setLoading(false);
      return;
    }
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
    enterGuest() {
      localStorage.setItem(GUEST_KEY, '1');
      setIsGuest(true);
    },
    exitGuest() {
      localStorage.removeItem(GUEST_KEY);
      setIsGuest(false);
    },
    async signInWithGoogle() {
      await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      });
    },
    async signInWithEmail(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    async signUpWithEmail(email, password) {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
    },
    async signOut() {
      if (isGuest) {
        value.exitGuest();
        return;
      }
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
