import { create } from 'zustand';

/**
 * Phase D · lightweight registry of active and recently-finished subagents.
 *
 * The authoritative state (promise, AbortController, raw text chunks) lives
 * in `src/lib/ai/subagent.ts`'s module-level map. This zustand store mirrors
 * a subset for the UI so badges / lists re-render without polling. Keep the
 * shape small — bulky output accumulators stay in the module.
 */

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubagentView {
  id: string;
  description: string;
  status: SubagentStatus;
  /** Truncated tail of the subagent's final message — enough for a hover
   *  preview. The full text lives in the module-level registry. */
  outputPreview: string;
  startedAt: number;
  endedAt?: number;
  error?: string;
  /** Audit-trail length. Stored here so the indicator re-renders when a
   *  new event lands — the full event list stays in the module-level
   *  registry and is fetched via `snapshotSubagent` when the user opens
   *  the detail panel. */
  eventCount: number;
}

interface SubagentsState {
  tasks: Record<string, SubagentView>;
  upsert: (view: SubagentView) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
}

export const useSubagentsStore = create<SubagentsState>()((set) => ({
  tasks: {},
  upsert: (view) =>
    set((state) => ({ tasks: { ...state.tasks, [view.id]: view } })),
  remove: (id) =>
    set((state) => {
      const next = { ...state.tasks };
      delete next[id];
      return { tasks: next };
    }),
  clearFinished: () =>
    set((state) => {
      const next: Record<string, SubagentView> = {};
      for (const [id, v] of Object.entries(state.tasks)) {
        if (v.status === 'running') next[id] = v;
      }
      return { tasks: next };
    }),
}));
