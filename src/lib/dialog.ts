export const CONFIRM_DIALOG_EVENT = 'inuchat:confirm-dialog';

export interface ConfirmDialogRequest {
  title: string;
  description?: string;
  confirmLabel?: string;
  resolve: (confirmed: boolean) => void;
}

export function showConfirmDialog(title: string, description = '', confirmLabel = '확인'): Promise<boolean> {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent<ConfirmDialogRequest>(CONFIRM_DIALOG_EVENT, {
      detail: { title, description, confirmLabel, resolve },
    }));
  });
}
