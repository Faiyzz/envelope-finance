'use client';

/**
 * Client UI stores - TD-10 §5.3 / §6.3
 *
 * `usePending` holds optimistic expenses applied on top of server data
 * (applyPendingExpenses). They are removed on success (after the server data
 * is refreshed) or on failure (rollback).
 */

import { create } from 'zustand';
import type { PendingExpense } from '@/domain/dashboard/optimistic';

interface PendingState {
  items: PendingExpense[];
  add: (p: PendingExpense) => void;
  remove: (key: string) => void;
}

export const usePending = create<PendingState>((set) => ({
  items: [],
  add: (p) => set((s) => ({ items: [...s.items, p] })),
  remove: (key) => set((s) => ({ items: s.items.filter((i) => i.key !== key) })),
}));

export interface ToastItem {
  id: string;
  message: string;
  tone: 'success' | 'error' | 'info';
  undo?: () => void | Promise<void>;
  undoLabel?: string;
  durationMs: number;
}

interface ToastState {
  items: ToastItem[];
  push: (t: Omit<ToastItem, 'id' | 'durationMs'> & { durationMs?: number }) => string;
  dismiss: (id: string) => void;
}

const MAX_TOASTS = 3;

export const useToasts = create<ToastState>((set) => ({
  items: [],
  push: (t) => {
    const id = crypto.randomUUID();
    set((s) => ({
      items: [...s.items, { durationMs: 6000, ...t, id }].slice(-MAX_TOASTS),
    }));
    return id;
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));

export const toast = (t: Parameters<ToastState['push']>[0]) => useToasts.getState().push(t);

/** Screen-reader announcements (TD-10 §6.4). */
interface LiveState {
  message: string;
  announce: (m: string) => void;
}
export const useLive = create<LiveState>((set) => ({
  message: '',
  // Clear then set so identical consecutive messages are re-announced.
  announce: (message) => {
    set({ message: '' });
    queueMicrotask(() => set({ message }));
  },
}));

/** Count of forms with unsaved input; the update prompt confirms before reloading (TD-12 §6). */
interface DirtyState {
  count: number;
  inc: () => void;
  dec: () => void;
}
export const useDirty = create<DirtyState>((set) => ({
  count: 0,
  inc: () => set((s) => ({ count: s.count + 1 })),
  dec: () => set((s) => ({ count: Math.max(0, s.count - 1) })),
}));
