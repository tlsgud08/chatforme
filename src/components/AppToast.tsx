import { useEffect, useRef, useState } from 'react';
import { TOAST_EVENT } from '@/lib/toast';

export default function AppToast() {
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const handle = (event: Event) => {
      setMessage((event as CustomEvent<string>).detail);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setMessage(''), 2600);
    };
    window.addEventListener(TOAST_EVENT, handle);
    return () => { window.removeEventListener(TOAST_EVENT, handle); if (timer.current) clearTimeout(timer.current); };
  }, []);
  if (!message) return null;
  return <div className="toast-enter pointer-events-none fixed inset-x-0 top-5 z-[100] flex justify-center px-4"><div className="rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-xl">{message}</div></div>;
}
