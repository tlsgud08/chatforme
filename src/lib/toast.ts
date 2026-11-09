export const TOAST_EVENT = 'inuchat:toast';

export interface ToastOptions {
  durationMs?: number;
  tone?: 'success' | 'warning';
}
export type ToastDetail = string | (ToastOptions & { message: string });

export function showToast(message: string, options?: ToastOptions) {
  window.dispatchEvent(new CustomEvent<ToastDetail>(TOAST_EVENT, { detail: options ? { ...options, message } : message }));
}
