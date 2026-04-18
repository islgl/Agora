import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSettingsStore } from '@/store/settingsStore';
import { ProviderIcon } from './ProviderIcon';
import type { ModelConfig, Provider } from '@/types';

interface ModelFormProps {
  existing?: ModelConfig;
  onClose: () => void;
}

interface ProviderPreset {
  label: string;
  modelPlaceholder: string;
  namePlaceholder: string;
}

const PROVIDER_PRESETS: Record<Provider, ProviderPreset> = {
  openai: {
    label: 'OpenAI',
    modelPlaceholder: 'gpt-4o-mini',
    namePlaceholder: 'GPT-4o',
  },
  anthropic: {
    label: 'Anthropic',
    modelPlaceholder: 'claude-sonnet-4-5',
    namePlaceholder: 'Claude Sonnet',
  },
  gemini: {
    label: 'Gemini',
    modelPlaceholder: 'gemini-2.0-flash',
    namePlaceholder: 'Gemini Flash',
  },
};

const PROVIDERS: Provider[] = ['openai', 'anthropic', 'gemini'];

const INPUT_CLASS =
  'rounded-xl border-border bg-card text-foreground ' +
  'focus-visible:border-ring focus-visible:ring-0 ' +
  'placeholder:text-muted-foreground';

export function ModelForm({ existing, onClose }: ModelFormProps) {
  const { addModelConfig, updateModelConfig, resolveModelConfig } =
    useSettingsStore();
  const [form, setForm] = useState({
    name: existing?.name ?? '',
    provider: existing?.provider ?? ('openai' as Provider),
    model: existing?.model ?? '',
  });
  const [testing, setTesting] = useState(false);

  const preset = PROVIDER_PRESETS[form.provider];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.model.trim()) {
      return;
    }
    if (existing) {
      await updateModelConfig({
        ...existing,
        name: form.name,
        provider: form.provider,
        model: form.model,
      });
    } else {
      // baseUrl / apiKey resolved from global settings at stream time.
      await addModelConfig({
        name: form.name,
        provider: form.provider,
        model: form.model,
        baseUrl: '',
        apiKey: '',
      });
    }
    onClose();
  };

  const handleTest = async () => {
    if (!form.model.trim()) {
      toast.error('Enter a model ID first');
      return;
    }
    const resolved = resolveModelConfig({
      id: existing?.id ?? '',
      name: form.name || form.model,
      provider: form.provider,
      model: form.model,
      baseUrl: '',
      apiKey: '',
    });
    setTesting(true);
    try {
      const msg = await invoke<string>('test_model_config', {
        modelConfig: resolved,
      });
      toast.success(msg);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-sm text-muted-foreground">Provider</Label>
        <div className="grid grid-cols-3 gap-2">
          {PROVIDERS.map((p) => {
            const active = form.provider === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => setForm((f) => ({ ...f, provider: p }))}
                className={`flex items-center justify-center gap-1.5 rounded-xl px-3 py-2
                            text-xs font-medium transition-colors ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
                style={
                  active
                    ? { boxShadow: '0 0 0 1px var(--primary)' }
                    : { boxShadow: '0 0 0 1px var(--border)' }
                }
              >
                <ProviderIcon
                  provider={p}
                  brandColor={!active}
                  className="size-3.5 shrink-0"
                />
                <span className="truncate">{PROVIDER_PRESETS[p].label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="name" className="text-sm text-muted-foreground">Display name</Label>
        <Input
          id="name"
          type="text"
          placeholder={preset.namePlaceholder}
          required
          className={INPUT_CLASS}
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="model" className="text-sm text-muted-foreground">Model ID</Label>
        <Input
          id="model"
          type="text"
          placeholder={preset.modelPlaceholder}
          required
          className={INPUT_CLASS}
          value={form.model}
          onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
        />
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        API key and base URL are shared across models — configure them in the
        <span className="font-medium"> Providers </span>
        tab.
      </p>

      <div className="flex items-center justify-between gap-2 pt-2">
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={testing}
          className="px-4 py-2 rounded-xl text-sm text-foreground bg-card
                     hover:bg-accent transition-colors disabled:opacity-60"
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm text-muted-foreground hover:text-foreground
                       hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 rounded-xl text-sm text-primary-foreground bg-primary
                       hover:bg-primary/90 transition-colors"
            style={{ boxShadow: '0 0 0 1px var(--primary)' }}
          >
            {existing ? 'Save' : 'Add model'}
          </button>
        </div>
      </div>
    </form>
  );
}
