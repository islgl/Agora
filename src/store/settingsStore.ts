import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type {
  BackgroundStatus,
  EmbeddingConfig,
  EmbeddingProvider,
  GlobalSettings,
  ModelConfig,
  Provider,
} from '@/types';
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
  workspaceRoot: '',
  autoApproveReadonly: true,
  hooksJson: '{}',
  activeModelId: '',
  embeddingProvider: 'openai',
  embeddingModel: 'text-embedding-3-small',
  embeddingConfigsJson: '{}',
  baseUrlEmbeddingCommon: '',
  autoMemoryEnabled: true,
  quickLaunchEnabled: true,
  closeToTrayEnabled: true,
  autoDreamOnIdle: false,
  dreamIdleMinutes: 60,
  nickname: '',
};

const EMBEDDING_PROVIDERS: readonly EmbeddingProvider[] = ['openai'];

function isEmbeddingProvider(value: unknown): value is EmbeddingProvider {
  return (
    typeof value === 'string' &&
    (EMBEDDING_PROVIDERS as readonly string[]).includes(value)
  );
}

interface EmbeddingConfigsBlob {
  configs: EmbeddingConfig[];
  activeId: string;
}

/** Parse `embeddingConfigsJson` defensively. Returns an empty blob on any
 *  malformed input — callers seed a default entry when `configs` is empty. */
function parseEmbeddingConfigs(raw: string): EmbeddingConfigsBlob {
  if (!raw || raw === '{}') return { configs: [], activeId: '' };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return { configs: [], activeId: '' };
    }
    const obj = parsed as Record<string, unknown>;
    const rawConfigs = Array.isArray(obj.configs) ? obj.configs : [];
    const configs: EmbeddingConfig[] = rawConfigs.flatMap((c): EmbeddingConfig[] => {
      if (!c || typeof c !== 'object') return [];
      const r = c as Record<string, unknown>;
      const id = typeof r.id === 'string' ? r.id : '';
      const name = typeof r.name === 'string' ? r.name : '';
      const provider = isEmbeddingProvider(r.provider) ? r.provider : 'openai';
      const model = typeof r.model === 'string' ? r.model : '';
      const providerId = typeof r.providerId === 'string' ? r.providerId : '';
      if (!id || !model) return [];
      return [{ id, name: name || model, provider, model, providerId }];
    });
    const activeId = typeof obj.activeId === 'string' ? obj.activeId : '';
    return { configs, activeId };
  } catch {
    return { configs: [], activeId: '' };
  }
}

function serializeEmbeddingConfigs(blob: EmbeddingConfigsBlob): string {
  return JSON.stringify(blob);
}

/** Derive the active embedding entry from a blob + the legacy
 *  `embeddingProvider` / `embeddingModel` fields. If the blob has no
 *  entries, seed one from the legacy fields so first-load works without a
 *  manual migration pass. */
function seedOrNormalizeEmbeddings(gs: GlobalSettings): {
  settings: GlobalSettings;
  configs: EmbeddingConfig[];
  activeId: string;
} {
  const parsed = parseEmbeddingConfigs(gs.embeddingConfigsJson);

  if (parsed.configs.length === 0) {
    const legacyProvider = isEmbeddingProvider(gs.embeddingProvider)
      ? gs.embeddingProvider
      : 'openai';
    const legacyModel = gs.embeddingModel || 'text-embedding-3-small';
    const seeded: EmbeddingConfig = {
      id: uuidv4(),
      name: defaultEmbeddingName(legacyProvider, legacyModel),
      provider: legacyProvider,
      model: legacyModel,
      providerId: '',
    };
    const blob: EmbeddingConfigsBlob = { configs: [seeded], activeId: seeded.id };
    const nextSettings: GlobalSettings = {
      ...gs,
      embeddingProvider: seeded.provider,
      embeddingModel: seeded.model,
      embeddingConfigsJson: serializeEmbeddingConfigs(blob),
    };
    return { settings: nextSettings, configs: blob.configs, activeId: blob.activeId };
  }

  const activeId = parsed.configs.some((c) => c.id === parsed.activeId)
    ? parsed.activeId
    : parsed.configs[0].id;
  const active = parsed.configs.find((c) => c.id === activeId)!;
  const nextSettings: GlobalSettings = {
    ...gs,
    embeddingProvider: active.provider,
    embeddingModel: active.model,
    embeddingConfigsJson: serializeEmbeddingConfigs({
      configs: parsed.configs,
      activeId,
    }),
  };
  return { settings: nextSettings, configs: parsed.configs, activeId };
}

function defaultEmbeddingName(_provider: EmbeddingProvider, model: string): string {
  return model || 'OpenAI';
}

interface SettingsState {
  modelConfigs: ModelConfig[];
  activeModelId: string | null;
  embeddingConfigs: EmbeddingConfig[];
  activeEmbeddingId: string | null;
  globalSettings: GlobalSettings;
  backgroundStatus: BackgroundStatus | null;

  loadModelConfigs: () => Promise<void>;
  addModelConfig: (cfg: Omit<ModelConfig, 'id'>) => Promise<void>;
  updateModelConfig: (cfg: ModelConfig) => Promise<void>;
  deleteModelConfig: (id: string) => Promise<void>;
  setActiveModel: (id: string) => Promise<void>;

  addEmbeddingConfig: (cfg: Omit<EmbeddingConfig, 'id'>) => Promise<void>;
  updateEmbeddingConfig: (cfg: EmbeddingConfig) => Promise<void>;
  deleteEmbeddingConfig: (id: string) => Promise<void>;
  setActiveEmbedding: (id: string) => Promise<void>;

  loadGlobalSettings: () => Promise<void>;
  saveGlobalSettings: (settings: GlobalSettings) => Promise<void>;
  loadBackgroundStatus: () => Promise<void>;
  setBackgroundStatus: (status: BackgroundStatus) => void;

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

/** Persist the full `GlobalSettings` after mutating `embeddingConfigsJson` +
 *  its derived active-config mirrors. Centralised so add/update/delete/
 *  setActive share one write path. */
async function persistEmbeddings(
  gs: GlobalSettings,
  configs: EmbeddingConfig[],
  activeId: string,
): Promise<GlobalSettings> {
  const active = configs.find((c) => c.id === activeId) ?? configs[0];
  const blob: EmbeddingConfigsBlob = {
    configs,
    activeId: active?.id ?? '',
  };
  const next: GlobalSettings = {
    ...gs,
    embeddingProvider: active?.provider ?? gs.embeddingProvider,
    embeddingModel: active?.model ?? gs.embeddingModel,
    embeddingConfigsJson: serializeEmbeddingConfigs(blob),
  };
  await invoke('save_global_settings', { settings: next });
  return next;
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  modelConfigs: [],
  activeModelId: null,
  embeddingConfigs: [],
  activeEmbeddingId: null,
  globalSettings: EMPTY_GLOBAL_SETTINGS,
  backgroundStatus: null,

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

  setActiveModel: async (id) => {
    // Optimistic in-store update so the UI reacts immediately, then persist
    // via save_global_settings. If save fails the promise rejects — callers
    // can surface a toast if they need to.
    const nextGs = { ...get().globalSettings, activeModelId: id };
    set({ activeModelId: id, globalSettings: nextGs });
    await invoke('save_global_settings', { settings: nextGs });
  },

  loadGlobalSettings: async () => {
    const raw = await invoke<GlobalSettings>('load_global_settings');
    const { settings, configs, activeId } = seedOrNormalizeEmbeddings(raw);
    // If normalization drifted from what's on disk (first-load seed or a
    // rescued malformed blob), write the canonical form back so the next
    // session skips the migration.
    if (settings.embeddingConfigsJson !== raw.embeddingConfigsJson) {
      void invoke('save_global_settings', { settings }).catch(() => {
        // Best-effort: if the write fails, the in-memory seed is still
        // valid for this session.
      });
    }
    // Hydrate activeModelId from the persisted value only when the store
    // doesn't already have one (prevents clobbering a just-clicked Use in
    // a session where globalSettings gets refreshed mid-flight).
    set((state) => ({
      globalSettings: settings,
      activeModelId: state.activeModelId || settings.activeModelId || null,
      embeddingConfigs: configs,
      activeEmbeddingId: state.activeEmbeddingId || activeId || null,
    }));
  },

  saveGlobalSettings: async (settings) => {
    await invoke('save_global_settings', { settings });
    const parsed = parseEmbeddingConfigs(settings.embeddingConfigsJson);
    set({
      globalSettings: settings,
      embeddingConfigs: parsed.configs,
      activeEmbeddingId: parsed.activeId || parsed.configs[0]?.id || null,
    });
    await get().loadBackgroundStatus();
  },

  loadBackgroundStatus: async () => {
    const status = await invoke<BackgroundStatus>('load_background_status');
    get().setBackgroundStatus(status);
  },

  setBackgroundStatus: (status) => {
    set((state) => ({
      backgroundStatus: status,
      globalSettings: {
        ...state.globalSettings,
        quickLaunchEnabled: status.quickLaunchEnabled,
      },
    }));
  },

  addEmbeddingConfig: async (cfg) => {
    const newCfg: EmbeddingConfig = {
      id: uuidv4(),
      name: cfg.name,
      provider: cfg.provider,
      model: cfg.model,
      providerId: cfg.providerId,
    };
    const configs = [...get().embeddingConfigs, newCfg];
    const activeId = get().activeEmbeddingId ?? newCfg.id;
    const next = await persistEmbeddings(get().globalSettings, configs, activeId);
    set({
      embeddingConfigs: configs,
      activeEmbeddingId: activeId,
      globalSettings: next,
    });
  },

  updateEmbeddingConfig: async (cfg) => {
    const configs = get().embeddingConfigs.map((c) =>
      c.id === cfg.id
        ? {
            ...c,
            name: cfg.name,
            provider: cfg.provider,
            model: cfg.model,
            providerId: cfg.providerId,
          }
        : c,
    );
    const activeId = get().activeEmbeddingId ?? configs[0]?.id ?? '';
    const next = await persistEmbeddings(get().globalSettings, configs, activeId);
    set({ embeddingConfigs: configs, globalSettings: next });
  },

  deleteEmbeddingConfig: async (id) => {
    const configs = get().embeddingConfigs.filter((c) => c.id !== id);
    const currentActive = get().activeEmbeddingId;
    const activeId = currentActive === id ? (configs[0]?.id ?? '') : (currentActive ?? '');
    const next = await persistEmbeddings(get().globalSettings, configs, activeId);
    set({
      embeddingConfigs: configs,
      activeEmbeddingId: activeId || null,
      globalSettings: next,
    });
  },

  setActiveEmbedding: async (id) => {
    const configs = get().embeddingConfigs;
    if (!configs.some((c) => c.id === id)) return;
    set({ activeEmbeddingId: id });
    const next = await persistEmbeddings(get().globalSettings, configs, id);
    set({ globalSettings: next });
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
