import { useEffect, useRef } from 'react';

interface Props {
  title: string;
  description: string;
  confirmLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ConfirmDialog({
  title,
  description,
  confirmLabel = '삭제',
  busy = false,
  onCancel,
  onConfirm,
}: Props) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-5" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
      <div className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-2xl">
        <h2 id="confirm-title" className="font-bold text-white">{title}</h2>
        <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-400">{description}</p>
        <div className="mt-5 flex gap-2">
          <button ref={cancelButtonRef} type="button" disabled={busy} onClick={onCancel} className="flex-1 rounded-lg bg-surface2 py-2.5 text-sm text-slate-300 disabled:opacity-50">
            취소
          </button>
          <button type="button" disabled={busy} onClick={onConfirm} className="flex-1 rounded-lg bg-red-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? '삭제 중…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
