import { create } from 'zustand';
import type { ConnectionStatus } from '../services/socket';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface UiState {
  toasts: Toast[];
  connection: ConnectionStatus;
  toast: (message: string, kind?: ToastKind, ms?: number) => void;
  dismiss: (id: number) => void;
  setConnection: (s: ConnectionStatus) => void;
}

let nextId = 1;

export const useUi = create<UiState>((set, get) => ({
  toasts: [],
  connection: 'idle',
  toast: (message, kind = 'info', ms = 3200) => {
    // Collapse identical messages that arrive in quick succession.
    if (get().toasts.some((t) => t.message === message)) return;
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message }] }));
    window.setTimeout(() => get().dismiss(id), ms);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setConnection: (connection) => set({ connection }),
}));

export const toast = (message: string, kind?: ToastKind, ms?: number) => useUi.getState().toast(message, kind, ms);
