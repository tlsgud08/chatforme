import { useState, useSyncExternalStore } from 'react';
import { useLocalProvider } from '@/hooks/useLocalProvider';
import { loadLocalPreferences, saveLocalPreferences, subscribeLocalPreferences } from '@/lib/localPreferences';
import LocalModelSelector from './LocalModelSelector';

export default function ProviderSettings() {
  const { provider, model, userId } = useLocalProvider();
  const summaryModel = useSyncExternalStore(subscribeLocalPreferences, () => loadLocalPreferences(userId).summaryModel, () => '');
  const topP = useSyncExternalStore(subscribeLocalPreferences, () => loadLocalPreferences(userId).topP, () => null);
  const [error, setError] = useState('');
  function save(patch: Parameters<typeof saveLocalPreferences>[1]) {
    if (!userId) return;
    try { saveLocalPreferences(userId, patch); setError(''); } catch { setError('브라우저 저장소를 사용할 수 없어 Local 설정을 저장하지 못했습니다.'); }
  }
  return <div className="mb-5 flex flex-col gap-3">
    <label className="text-sm font-semibold text-white">모델 제공자
      <select aria-label="모델 제공자" value={provider} onChange={e => save({ provider: e.target.value === 'local' ? 'local' : 'openrouter' })} className="mt-2 w-full rounded-lg bg-surface px-4 py-3 text-sm">
        <option value="openrouter">OpenRouter</option><option value="local">Local (LM Studio)</option>
      </select>
    </label>
    <p className="text-xs text-slate-500">이 계정·브라우저에 적용됩니다. 다른 기기에서도 로그인 후 제공자를 선택하세요. OpenRouter 설정과 키는 별도로 유지됩니다.</p>
    {provider === 'local' && <>
      <LocalModelSelector model={model} onModelChange={value => save({ model: value })} label="기본 Local 모델" />
      <LocalModelSelector model={summaryModel} onModelChange={value => save({ summaryModel: value })} label="Local 요약 모델 (미선택 시 대화 모델)" emptyLabel="Local 대화 모델 사용" />
      <label className="text-xs text-slate-400">Local Top-P (비우면 서버 기본값)
        <input aria-label="Local Top-P" type="number" min={0} max={1} step={0.01} value={topP ?? ''} onChange={e => {
          const value = e.target.value === '' ? null : e.target.valueAsNumber;
          if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) return;
          save({ topP: value });
        }} className="mt-1 w-full rounded-lg bg-surface px-3 py-2" />
      </label>
      <p className="text-xs text-slate-400">서버에서 허용한 계정만 연결할 수 있습니다. PC 주소·인증정보는 서버에서 관리합니다. 컨텍스트 초과 시 자동 삭제·요약하지 않습니다. KV 캐시는 LM Studio 메모리에서 관리하며 적중은 보장되지 않습니다.</p>
    </>}
    {error && <p role="alert" className="text-xs text-amber-400">{error}</p>}
  </div>;
}
