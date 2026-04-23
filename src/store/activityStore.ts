import { create } from 'zustand';

/**
 * Lightweight activity tracker. `lastActivityAt` records the wall-clock
 * of the most recent user-driven conversation turn (call `bump()` after
 * a turn completes). The idle-triggered Dreaming effect in App.tsx
 * polls this to decide whether the user has paused long enough.
 */
interface ActivityState {
  lastActivityAt: number;
  bump: () => void;
}

export const useActivityStore = create<ActivityState>((set) => ({
  lastActivityAt: Date.now(),
  bump: () => set({ lastActivityAt: Date.now() }),
}));
