import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { GlobalSettings, ModelConfig, Provider } from '@/types';
import { v4 as uuidv4 } from 'uuid';

const EMPTY_GLOBAL_SETTINGS: GlobalSettings = {
  apiKey: '',
  baseUrlOpenai: 'https://api.openai.com/v1',
  baseUrlAnthropic: 'https://api.anthropic.com',
  baseUrlGemini: 'https://generativelanguage.googleapis.com',
  tavilyApiKey: '',
  webSearchEnabled: true,
  autoTitleMode: 'every',
  thinkingEffort: 'off',
};

interface SettingsState {
  modelConfigs: ModelConfig[];
  activeModelId: string | null;
  globalSettings: GlobalSettings;

  loadModelConfigs: () => Promise<void>;
  addModelConfig: (cfg: Omit<ModelConfig, 'id'>) => Promise<void>;
  updateModelConfig: (cfg: ModelConfig) => Promise<void>;
  deleteModelConfig: (id: string) => Promise<void>;
  setActiveModel: (id: string) => void;

  loadGlobalSettings: () => Promise<void>;
  saveGlobalSettings: (settings: GlobalSettings) => Promise<void>;

  /** Merge per-model config with shared base URL + API key. */
  resolveModelConfig: (config: ModelConfig) => ModelConfig;
}

export function baseUrlForProvider(
  gs: GlobalSettings,
  provider: Provider,
): string {
  switch (provider) {
    case 'openai':
      return gs.baseUrlOpenai;
    case 'anthropic':
      return gs.baseUrlAnthropic;
    case 'gemini':
      return gs.baseUrlGemini;
  }
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  modelConfigs: [],
  activeModelId: null,
  globalSettings: EMPTY_GLOBAL_SETTINGS,

  loadModelConfigs: async () => {
    const configs = await invoke<ModelConfig[]>('load_model_configs');
    set((state) => {
      const activeStillValid =
        state.activeModelId &&
        configs.some((c) => c.id === state.activeModelId);
      return {
        modelConfigs: configs,
        activeModelId: activeStillValid
          ? state.activeModelId
          : (configs[0]?.id ?? null),
      };
    });
  },

  addModelConfig: async (cfg) => {
    const newCfg: ModelConfig = {
      id: uuidv4(),
      name: cfg.name,
      provider: cfg.provider,
      model: cfg.model,
      // baseUrl / apiKey are resolved from global settings at request time;
      // persist blanks so the DB row stays schema-compliant.
      baseUrl: '',
      apiKey: '',
    };
    const configs = [...get().modelConfigs, newCfg];
    await invoke('save_model_configs', { configs });
    set((state) => ({
      modelConfigs: configs,
      activeModelId: state.activeModelId ?? newCfg.id,
    }));
  },

  updateModelConfig: async (cfg) => {
    const configs = get().modelConfigs.map((c) =>
      c.id === cfg.id
        ? {
            ...c,
            name: cfg.name,
            provider: cfg.provider,
            model: cfg.model,
          }
        : c,
    );
    await invoke('save_model_configs', { configs });
    set({ modelConfigs: configs });
  },

  deleteModelConfig: async (id) => {
    const configs = get().modelConfigs.filter((c) => c.id !== id);
    await invoke('save_model_configs', { configs });
    set((state) => ({
      modelConfigs: configs,
      activeModelId:
        state.activeModelId === id ? (configs[0]?.id ?? null) : state.activeModelId,
    }));
  },

  setActiveModel: (id) => set({ activeModelId: id }),

  loadGlobalSettings: async () => {
    const settings = await invoke<GlobalSettings>('load_global_settings');
    set({ globalSettings: settings });
  },

  saveGlobalSettings: async (settings) => {
    await invoke('save_global_settings', { settings });
    set({ globalSettings: settings });
  },

  resolveModelConfig: (config) => {
    const gs = get().globalSettings;
    return {
      ...config,
      baseUrl: baseUrlForProvider(gs, config.provider),
      apiKey: gs.apiKey,
    };
  },
}));
