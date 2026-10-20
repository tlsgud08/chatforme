import { useState, useSyncExternalStore } from 'react';
import {
  loadInterfaceDesign, saveInterfaceDesign, subscribeInterfaceDesign,
  loadAppWidthLimited, saveAppWidthLimited, loadChatWidthLimited, saveChatWidthLimited, subscribeInterfaceWidth,
} from '@/lib/interfacePreference';

export default function InterfacePreferences() {
  const design = useSyncExternalStore(subscribeInterfaceDesign, loadInterfaceDesign, () => 'modern' as const);
  const appWidthLimited = useSyncExternalStore(subscribeInterfaceWidth, loadAppWidthLimited, () => false);
  const chatWidthLimited = useSyncExternalStore(subscribeInterfaceWidth, loadChatWidthLimited, () => true);
  const [error, setError] = useState('');
  const saveError = '화면 설정을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.';

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
            onClick={() => setError(saveInterfaceDesign(option.value) ? '' : saveError)}
            className={`rounded-xl border px-4 py-3 text-left ${design === option.value ? 'border-brand bg-brand/10' : 'border-surface2 bg-surface'}`}
          >
            <span className={`block text-sm font-semibold ${design === option.value ? 'text-brand' : 'text-white'}`}>{option.label}</span>
            <span className="mt-1 block text-xs text-slate-400">{option.description}</span>
          </button>
        ))}
      </div>
      {design === 'modern' && (
        <fieldset className="mt-4 space-y-2">
          <legend className="mb-2 text-sm font-semibold text-white">화면 너비</legend>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg bg-surface px-3 py-3">
            <input
              type="checkbox"
              checked={appWidthLimited}
              onChange={event => setError(saveAppWidthLimited(event.target.checked) ? '' : saveError)}
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-describedby="interface-app-width-description"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-white">전체 화면 너비 450px 제한</span>
              <span id="interface-app-width-description" className="mt-1 block text-xs text-slate-400">사이트 전체를 최대 450px로 제한하고 가운데 배치합니다.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg bg-surface px-3 py-3">
            <input
              type="checkbox"
              checked={chatWidthLimited}
              onChange={event => setError(saveChatWidthLimited(event.target.checked) ? '' : saveError)}
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-describedby="interface-chat-width-description"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-white">채팅 메시지 너비만 450px 제한</span>
              <span id="interface-chat-width-description" className="mt-1 block text-xs text-slate-400">헤더와 입력창 너비는 유지하고 메시지 영역만 가운데 모아 표시합니다.</span>
            </span>
          </label>
        </fieldset>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
    </section>
  );
}
