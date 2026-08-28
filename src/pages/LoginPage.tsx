import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';

export default function LoginPage() {
  const { signInWithEmail, signUpWithEmail } = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [masterPassword, setMasterPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!email.trim()) { setError('이메일을 입력해주세요.'); return; }
    if (!/^\S+@\S+\.\S+$/.test(email)) { setError('올바른 이메일 주소를 입력해주세요.'); return; }
    if (!password) { setError('비밀번호를 입력해주세요.'); return; }
    if (mode === 'signup' && !masterPassword) { setError('마스터 비밀번호를 입력해주세요.'); return; }
    setBusy(true);
    try {
      if (mode === 'signin') await signInWithEmail(email, password);
      else {
        await signUpWithEmail(email, password, masterPassword);
        setError('가입 확인 메일을 보냈습니다. 메일을 확인해주세요.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-app flex-col justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-white">Inuchat</h1>
        <p className="mt-1 text-sm text-slate-400">AI 롤플레잉 채팅</p>
      </div>

      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <input
          type="email"
          placeholder="이메일"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-lg bg-surface px-4 py-3 text-sm outline-none"
        />
        {mode === 'signup' && (
          <input
            type="password"
            autoComplete="off"
            placeholder="마스터 비밀번호"
            value={masterPassword}
            onChange={(e) => setMasterPassword(e.target.value)}
            className="rounded-lg bg-surface px-4 py-3 text-sm outline-none"
          />
        )}
        <input
          type="password"
          placeholder="비밀번호"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-lg bg-surface px-4 py-3 text-sm outline-none"
        />
        {error && <p className="text-sm text-amber-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-brand py-3 font-semibold text-white disabled:opacity-50"
        >
          {mode === 'signin' ? '로그인' : '회원가입'}
        </button>
      </form>

      <button
        onClick={() => setMode((m) => (m === 'signin' ? 'signup' : 'signin'))}
        className="text-sm text-slate-400 underline"
      >
        {mode === 'signin' ? '계정이 없으신가요? 회원가입' : '이미 계정이 있으신가요? 로그인'}
      </button>

    </div>
  );
}
