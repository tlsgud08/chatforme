import { useState, useSyncExternalStore } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useLocalProvider } from '@/hooks/useLocalProvider';
import { loadLocalPreferences, saveLocalPreferences, subscribeLocalPreferences } from '@/lib/localPreferences';
import type { Provider } from '@/types/db';

export default function SummaryProviderSelect({ sessionId }: { sessionId?: string }) {
  const { user } = useAuth();
  const { provider } = useLocalProvider(sessionId, true);
  const [error, setError] = useState('');
  const value = useSyncExternalStore(subscribeLocalPreferences, () => {
    const p = loadLocalPreferences(user?.id);
    return sessionId ? p.sessionSummaryProviders[sessionId] ?? 'default' : p.summaryProvider;
  }, () => 'default' as const);
  function change(selection: 'default' | Provider) {
    if (!user) return;
    try {
      saveLocalPreferences(user.id, sessionId ? { sessionSummaryProviders: { ...loadLocalPreferences(user.id).sessionSummaryProviders, [sessionId]: selection } } : { summaryProvider: selection });
      setError('');
    } catch { setError('브라우저 저장소를 사용할 수 없어 요약 제공자를 저장하지 못했습니다.'); }
  }
  return <div className="flex flex-col gap-2">
    <label className="text-xs text-slate-400">{sessionId ? '이 채팅방 요약 제공자' : '요약 제공자'}
      <select aria-label={sessionId ? '이 채팅방 요약 제공자' : '요약 제공자'} value={value}
        onChange={e => change(e.target.value as 'default' | Provider)} className="mt-1 w-full rounded-lg bg-surface2 px-3 py-2 text-sm text-white">
        <option value="default">{sessionId ? '전역 요약 제공자 사용' : '대화 제공자 따르기'}</option>
        <option value="openrouter">OpenRouter</option><option value="local">Local (LM Studio)</option>
      </select>
    </label>
    <p className="text-xs text-slate-400">{provider === 'openrouter'
      ? '요약은 OpenRouter로 전송합니다. 기존 API 키와 요약 모델을 사용하며 실제 API 비용이 기록됩니다.'
      : '요약은 Local 모델로 생성하며 API 비용은 0원입니다.'} 이 계정·브라우저에 저장됩니다.</p>
    {error && <p role="alert" className="text-xs text-amber-400">{error}</p>}
  </div>;
}
