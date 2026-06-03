import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';

export default function LoginPage() {
  const { signInWithGoogle, signInWithEmail, signUpWithEmail, enterGuest } = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showGuestWarning, setShowGuestWarning] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'signin') await signInWithEmail(email, password);
      else {
        await signUpWithEmail(email, password);
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
        <h1 className="text-2xl font-bold text-white">Nekochat</h1>
        <p className="mt-1 text-sm text-slate-400">AI 롤플레잉 채팅</p>
      </div>

      <button
        onClick={() => signInWithGoogle()}
        className="rounded-lg bg-white py-3 font-semibold text-slate-900"
      >
        Google 계정으로 계속하기
      </button>

      <div className="flex items-center gap-3 text-xs text-slate-500">
        <div className="h-px flex-1 bg-surface2" /> 또는 <div className="h-px flex-1 bg-surface2" />
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          type="email"
          required
          placeholder="이메일"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-lg bg-surface px-4 py-3 text-sm outline-none"
        />
        <input
          type="password"
          required
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

      <button
        onClick={() => setShowGuestWarning(true)}
        className="text-sm text-slate-500"
      >
        비회원으로 계속
      </button>

      {/* 비회원 경고 모달 */}
      {showGuestWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
          <div className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-surface p-6">
            <h2 className="font-bold text-white">비회원 모드 안내</h2>
            <ul className="flex flex-col gap-2 text-sm text-slate-300">
              <li>⚠️ 채팅 기록이 이 기기 브라우저에만 저장됩니다.</li>
              <li>⚠️ 브라우저 캐시·데이터를 삭제하면 기록이 <strong>영구 삭제</strong>됩니다.</li>
              <li>⚠️ 작품 제작은 로그인 후 이용 가능합니다.</li>
            </ul>
            <div className="flex gap-3">
              <button
                onClick={() => setShowGuestWarning(false)}
                className="flex-1 rounded-lg bg-surface2 py-2.5 text-sm text-slate-300"
              >
                취소
              </button>
              <button
                onClick={enterGuest}
                className="flex-1 rounded-lg bg-brand py-2.5 text-sm font-semibold text-white"
              >
                비회원으로 계속
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
