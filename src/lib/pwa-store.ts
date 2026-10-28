'use client';

import { create } from 'zustand';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface InstallState {
  deferred: BeforeInstallPromptEvent | null;
  standalone: boolean;
  setDeferred: (e: BeforeInstallPromptEvent | null) => void;
  setStandalone: (v: boolean) => void;
}

export const useInstall = create<InstallState>((set) => ({
  deferred: null,
  standalone: false,
  setDeferred: (deferred) => set({ deferred }),
  setStandalone: (standalone) => set({ standalone }),
}));

export function isIosSafari(ua: string, platform = ''): boolean {
  const iOS = /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && typeof document !== 'undefined' && 'ontouchend' in document);
  const webkit = /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return iOS && webkit;
}
