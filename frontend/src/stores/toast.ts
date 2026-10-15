import { create } from 'zustand';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'ok' | 'warn' | 'error';
}

interface ToastState {
  toasts: Toast[];
  show(text: string, tone?: Toast['tone']): void;
  dismiss(id: number): void;
}

let seq = 0;
const TTL_MS = 4_000;

/** 畫面下方的短暫提示（指令結果、遙控被接管等） */
export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  show(text, tone = 'info') {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }].slice(-4) }));
    setTimeout(() => get().dismiss(id), TTL_MS);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));
