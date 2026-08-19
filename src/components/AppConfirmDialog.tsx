import { useCallback, useEffect, useState } from 'react';
import ConfirmDialog from '@/components/ConfirmDialog';
import { CONFIRM_DIALOG_EVENT, type ConfirmDialogRequest } from '@/lib/dialog';

export default function AppConfirmDialog() {
  const [request, setRequest] = useState<ConfirmDialogRequest | null>(null);
  const close = useCallback((confirmed: boolean) => {
    setRequest((current) => {
      current?.resolve(confirmed);
      return null;
    });
  }, []);

  useEffect(() => {
    const handle = (event: Event) => {
      const next = (event as CustomEvent<ConfirmDialogRequest>).detail;
      setRequest((current) => {
        current?.resolve(false);
        return next;
      });
    };
    window.addEventListener(CONFIRM_DIALOG_EVENT, handle);
    return () => window.removeEventListener(CONFIRM_DIALOG_EVENT, handle);
  }, []);

  if (!request) return null;
  return <ConfirmDialog title={request.title} description={request.description ?? ''} confirmLabel={request.confirmLabel} onCancel={() => close(false)} onConfirm={() => close(true)} />;
}
