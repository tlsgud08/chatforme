import { useState, useSyncExternalStore } from 'react';
import { loadInterfaceDesign, saveInterfaceDesign, subscribeInterfaceDesign } from '@/lib/interfacePreference';

export default function InterfacePreferences() {
  const design = useSyncExternalStore(subscribeInterfaceDesign, loadInterfaceDesign, () => 'modern' as const);
  const [error, setError] = useState('');

  return (
    <section aria-labelledby="interface-design-title">
      <h2 id="interface-design-title" className="font-semibold text-white">화면 디자인</h2>
      <p className="mb-3 mt-1 text-xs text-slate-500">
        이 기기에서 사용할 화면 구성을 선택하세요. 색상 테마와 작품의 테마 전환 설정은 그대로 유지됩니다.
      </p>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="화면 디자인">
        {([{ value: 'modern', label: '개선형', description: '화면 너비에 맞춘 배치' },
          { value: 'legacy', label: '레거시', description: '기존 480px 화면과 하단 탭' }] as const).map(option => (
          <button
            key={option.value}
            type="button"
            aria-pressed={design === option.value}
            onClick={() => setError(saveInterfaceDesign(option.value) ? '' : '화면 설정을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.')}
            className={`rounded-xl border px-4 py-3 text-left ${design === option.value ? 'border-brand bg-brand/10' : 'border-surface2 bg-surface'}`}
          >
            <span className={`block text-sm font-semibold ${design === option.value ? 'text-brand' : 'text-white'}`}>{option.label}</span>
            <span className="mt-1 block text-xs text-slate-400">{option.description}</span>
          </button>
        ))}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
    </section>
  );
}
