import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AgentMdPayload } from '@/types';

/**
 * Phase E · cache for the workspace `AGENT.md` contents. Refreshed each
 * time the ChatArea mounts / workspace root changes. Kept as a separate
 * store so other components (status chip, settings pane) can subscribe
 * without depending on the heavier chat store.
 */

const EMPTY: AgentMdPayload = { path: null, content: '', truncated: false };

interface AgentMdState {
  payload: AgentMdPayload;
  loading: boolean;
  refresh: () => Promise<void>;
}

export const useAgentMdStore = create<AgentMdState>()((set) => ({
  payload: EMPTY,
  loading: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const payload = await invoke<AgentMdPayload>('read_agent_md');
      set({ payload, loading: false });
    } catch (err) {
      console.warn('read_agent_md failed', err);
      set({ payload: EMPTY, loading: false });
    }
  },
}));
