import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Skill, SkillDraft, SkillsMeta } from '@/types';

interface SkillsState {
  skills: Skill[];
  meta: SkillsMeta | null;
  loading: boolean;
  load: () => Promise<void>;
  loadMeta: () => Promise<void>;
  rescan: () => Promise<void>;
  setScriptsEnabled: (enabled: boolean) => Promise<void>;
  openFolder: () => Promise<void>;
  importFolder: () => Promise<string | null>;
  create: (draft: SkillDraft) => Promise<string>;
  remove: (name: string) => Promise<void>;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  meta: null,
  loading: false,
  load: async () => {
    set({ loading: true });
    try {
      const skills = await invoke<Skill[]>('load_skills');
      set({ skills, loading: false });
    } catch (e) {
      console.error('load_skills failed', e);
      set({ loading: false });
    }
  },
  loadMeta: async () => {
    try {
      const meta = await invoke<SkillsMeta>('get_skills_meta');
      set({ meta });
    } catch (e) {
      console.error('get_skills_meta failed', e);
    }
  },
  rescan: async () => {
    set({ loading: true });
    try {
      const skills = await invoke<Skill[]>('rescan_skills');
      set({ skills, loading: false });
    } catch (e) {
      console.error('rescan_skills failed', e);
      set({ loading: false });
    }
  },
  setScriptsEnabled: async (enabled) => {
    await invoke('set_skills_scripts_enabled', { enabled });
    const meta = get().meta;
    if (meta) set({ meta: { ...meta, scriptsEnabled: enabled } });
    // Re-fetch skills so `run_skill_script` surfaces/disappears in the catalog.
    await get().rescan();
  },
  openFolder: async () => {
    await invoke('open_skills_folder');
  },
  importFolder: async () => {
    const name = await invoke<string | null>('import_skill_folder');
    if (name) await get().load();
    return name;
  },
  create: async (draft) => {
    const name = await invoke<string>('create_skill', { draft });
    await get().load();
    return name;
  },
  remove: async (name) => {
    await invoke('delete_skill', { name });
    await get().load();
  },
}));
