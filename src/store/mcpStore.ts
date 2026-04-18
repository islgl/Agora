import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { McpServerConfig } from '@/types';

interface McpState {
  servers: McpServerConfig[];
  loading: boolean;
  load: () => Promise<void>;
  save: (server: McpServerConfig) => Promise<McpServerConfig>;
  remove: (id: string) => Promise<void>;
  test: (server: McpServerConfig) => Promise<number>;
}

export const useMcpStore = create<McpState>((set) => ({
  servers: [],
  loading: false,
  load: async () => {
    set({ loading: true });
    try {
      const servers = await invoke<McpServerConfig[]>('load_mcp_servers');
      set({ servers, loading: false });
    } catch (e) {
      console.error('load_mcp_servers failed', e);
      set({ loading: false });
    }
  },
  save: async (server) => {
    const saved = await invoke<McpServerConfig>('save_mcp_server', { server });
    set((s) => {
      const idx = s.servers.findIndex((x) => x.id === saved.id);
      if (idx < 0) return { servers: [...s.servers, saved] };
      const copy = s.servers.slice();
      copy[idx] = saved;
      return { servers: copy };
    });
    return saved;
  },
  remove: async (id) => {
    await invoke('delete_mcp_server', { id });
    set((s) => ({ servers: s.servers.filter((x) => x.id !== id) }));
  },
  test: (server) => invoke<number>('test_mcp_server', { server }),
}));
