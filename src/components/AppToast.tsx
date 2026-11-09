import { useEffect, useRef, useState } from 'react';
import { TOAST_EVENT, type ToastDetail } from '@/lib/toast';

export default function AppToast() {
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState<'success' | 'warning'>('success');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<ToastDetail>).detail;
      const options = typeof detail === 'string' ? { message: detail } : detail;
      setMessage(options.message);
      setTone(options.tone ?? 'success');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setMessage(''), options.durationMs ?? 2600);
    };
    window.addEventListener(TOAST_EVENT, handle);
    return () => { window.removeEventListener(TOAST_EVENT, handle); if (timer.current) clearTimeout(timer.current); };
  }, []);
  if (!message) return null;
  return <div role="status" aria-live="polite" className="toast-enter pointer-events-none fixed inset-x-0 top-5 z-[100] flex justify-center px-4"><div className={`max-w-full rounded-2xl px-5 py-2.5 text-center text-sm font-semibold text-white shadow-xl ${tone === 'warning' ? 'bg-amber-700' : 'bg-emerald-600'}`}>{message}</div></div>;
}
