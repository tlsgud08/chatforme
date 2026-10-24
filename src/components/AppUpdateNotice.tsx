import { useState, useSyncExternalStore } from 'react';
import { hasAppUpdate, subscribeAppUpdate } from '@/lib/appUpdate';

export default function AppUpdateNotice() {
  const available = useSyncExternalStore(subscribeAppUpdate, hasAppUpdate, () => false);
  const [dismissed, setDismissed] = useState(false);
  if (!available || dismissed) return null;
  return <aside role="status" aria-label="앱 업데이트 안내" className="fixed inset-x-3 bottom-20 z-[100] mx-auto max-w-lg rounded-xl border border-indigo-400/50 bg-slate-900 p-4 text-sm text-slate-100 shadow-xl">
    <p className="font-semibold">새 버전이 준비되어 있어요.</p>
    <p className="mt-1 leading-relaxed">작성 중인 내용을 저장한 뒤 이 사이트의 모든 탭과 설치 앱을 완전히 닫고 다시 열어 주세요. 현재 화면은 이전 버전으로 실행 중이에요.</p>
    <button type="button" onClick={() => setDismissed(true)} className="mt-2 rounded-lg bg-indigo-600 px-3 py-1.5 font-semibold text-white">확인</button>
  </aside>;
}
