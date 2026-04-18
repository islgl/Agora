import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { useSettingsStore } from '@/store/settingsStore';
import { ProviderIcon } from './ProviderIcon';
import { MaskedKeyInput } from './MaskedKeyInput';
import { SectionDivider } from './SectionDivider';
import type { GlobalSettings, Provider } from '@/types';

const INPUT_CLASS =
  'rounded-xl border-border bg-card text-foreground ' +
  'focus-visible:border-ring focus-visible:ring-0 ' +
  'placeholder:text-muted-foreground';

const PROVIDER_LABEL: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

type BaseUrlField = 'baseUrlOpenai' | 'baseUrlAnthropic' | 'baseUrlGemini';

const BASE_URL_FIELD: Record<Provider, BaseUrlField> = {
  openai: 'baseUrlOpenai',
  anthropic: 'baseUrlAnthropic',
  gemini: 'baseUrlGemini',
};

const PROVIDERS: Provider[] = ['openai', 'anthropic', 'gemini'];

export function ProvidersForm() {
  const { globalSettings, saveGlobalSettings } = useSettingsStore();
  const [form, setForm] = useState<GlobalSettings>(globalSettings);
  const [saving, setSaving] = useState(false);

  // Keep local form in sync when store changes (e.g. first load).
  useEffect(() => {
    setForm(globalSettings);
  }, [globalSettings]);

  const dirty =
    form.apiKey !== globalSettings.apiKey ||
    form.baseUrlOpenai !== globalSettings.baseUrlOpenai ||
    form.baseUrlAnthropic !== globalSettings.baseUrlAnthropic ||
    form.baseUrlGemini !== globalSettings.baseUrlGemini;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await saveGlobalSettings(form);
      toast.success('Provider settings saved');
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-1.5">
        <Label htmlFor="apiKey" className="text-sm text-muted-foreground">
          API key
        </Label>
        <MaskedKeyInput
          id="apiKey"
          placeholder="••••"
          className={INPUT_CLASS}
          value={form.apiKey}
          onChange={(next) => setForm((f) => ({ ...f, apiKey: next }))}
        />
        <p className="text-xs text-muted-foreground">
          Shared across every provider — useful when all traffic goes through a
          single gateway.
        </p>
      </div>

      <SectionDivider />

      <div className="space-y-3">
        <Label className="text-sm text-muted-foreground">Base URLs</Label>
        {PROVIDERS.map((p) => {
          const field = BASE_URL_FIELD[p];
          return (
            <div key={p} className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 w-28 shrink-0">
                <ProviderIcon provider={p} className="size-3.5 shrink-0" />
                <span className="text-xs text-muted-foreground">
                  {PROVIDER_LABEL[p]}
                </span>
              </div>
              <Input
                type="text"
                className={`${INPUT_CLASS} flex-1`}
                value={form[field]}
                onChange={(e) =>
                  setForm((f) => ({ ...f, [field]: e.target.value }))
                }
              />
            </div>
          );
        })}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="submit"
          disabled={!dirty || saving}
          className="px-4 py-2 rounded-xl text-sm text-primary-foreground bg-primary
                     hover:bg-primary/90 transition-colors
                     disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ boxShadow: '0 0 0 1px var(--primary)' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
