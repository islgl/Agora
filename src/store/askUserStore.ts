import { create } from 'zustand';
import type { AskUserRequest } from '@/types';

/**
 * Pending-clarification queue for the `ask_user` tool. Mirrors the approval
 * queue in `permissionsStore`: one visible prompt at a time, additional
 * calls wait in FIFO order. Kept in a dedicated store so clarifications
 * don't interleave with permission prompts — they render separately and
 * can both be pending simultaneously.
 */

interface PendingEntry {
  request: AskUserRequest;
  resolve: (answer: string) => void;
}

interface AskUserState {
  currentPrompt: AskUserRequest | null;
  queue: PendingEntry[];
  currentResolve: ((answer: string) => void) | null;

  /** Queue a request. Resolves with the user's answer text. */
  request: (req: AskUserRequest) => Promise<string>;
  /** Called by the UI once the user picks an option or submits free text. */
  answerCurrent: (answer: string) => void;
}

export const useAskUserStore = create<AskUserState>()((set, get) => ({
  currentPrompt: null,
  queue: [],
  currentResolve: null,

  request: (req) =>
    new Promise<string>((resolve) => {
      const state = get();
      if (state.currentPrompt) {
        set({ queue: [...state.queue, { request: req, resolve }] });
      } else {
        set({ currentPrompt: req, currentResolve: resolve });
      }
    }),

  answerCurrent: (answer) => {
    const state = get();
    const resolve = state.currentResolve;
    if (resolve) resolve(answer);
    const [next, ...rest] = state.queue;
    if (next) {
      set({
        currentPrompt: next.request,
        currentResolve: next.resolve,
        queue: rest,
      });
    } else {
      set({ currentPrompt: null, currentResolve: null, queue: [] });
    }
  },
}));
