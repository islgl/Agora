import { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { toast } from 'sonner';
import { useSettingsStore } from '@/store/settingsStore';
import { MaskedKeyInput } from './MaskedKeyInput';
import { SectionDivider } from './SectionDivider';
import type { GlobalSettings, ThinkingEffort } from '@/types';

const THINKING_OPTIONS: {
  value: ThinkingEffort;
  label: string;
  hint: string;
}[] = [
  { value: 'off', label: 'Off', hint: 'No extended reasoning. Cheapest, fastest.' },
  { value: 'low', label: 'Low', hint: '~2k reasoning tokens.' },
  { value: 'medium', label: 'Medium', hint: '~8k reasoning tokens.' },
  { value: 'high', label: 'High', hint: '~16k reasoning tokens.' },
  {
    value: 'max',
    label: 'Max',
    hint: '48k+ budget (Anthropic) / dynamic (Gemini). OpenAI caps at "high".',
  },
];

const INPUT_CLASS =
  'rounded-xl border-border bg-card text-foreground ' +
  'focus-visible:border-ring focus-visible:ring-0 ' +
  'placeholder:text-muted-foreground';

export function CapabilitiesForm() {
  const { globalSettings, saveGlobalSettings } = useSettingsStore();
  const [form, setForm] = useState<GlobalSettings>(globalSettings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(globalSettings);
  }, [globalSettings]);

  const dirty =
    form.webSearchEnabled !== globalSettings.webSearchEnabled ||
    form.tavilyApiKey !== globalSettings.tavilyApiKey ||
    form.thinkingEffort !== globalSettings.thinkingEffort;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await saveGlobalSettings(form);
      toast.success('Capabilities saved');
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-3">
        <div
          className="flex items-start gap-3 p-3 rounded-xl bg-card"
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
        >
          <div className="space-y-0.5 flex-1 min-w-0">
            <div className="text-sm text-foreground">Web search</div>
            <div className="text-xs text-muted-foreground">
              Lets the model ground answers in fresh web results. Prefers the
              provider's native tool; falls back to Tavily if unavailable.
              Toggle per-turn from the globe button in the chat input.
            </div>
          </div>
          <Toggle
            checked={form.webSearchEnabled}
            onCheckedChange={(checked) =>
              setForm((f) => ({ ...f, webSearchEnabled: checked }))
            }
            className="mt-0.5"
          />
        </div>

        <div className="space-y-1.5 pl-4">
          <Label
            htmlFor="tavilyApiKey"
            className="text-sm text-muted-foreground"
          >
            Tavily API key
          </Label>
          <MaskedKeyInput
            id="tavilyApiKey"
            placeholder="tvly-…"
            className={INPUT_CLASS}
            value={form.tavilyApiKey}
            onChange={(next) =>
              setForm((f) => ({ ...f, tavilyApiKey: next }))
            }
          />
          <p className="text-xs text-muted-foreground">
            Used as a fallback when the model's native search isn't available
            (e.g. the gateway strips Anthropic's tool). Leave blank to disable
            the fallback.
          </p>
        </div>
      </div>

      <SectionDivider />

      <div className="space-y-2">
        <Label className="text-sm text-muted-foreground">
          Extended thinking
        </Label>
        <p className="text-[11px] text-muted-foreground">
          How much internal reasoning the model can produce before answering.
          Only supported models use this; others respond normally (no error).
        </p>
        <div className="grid grid-cols-5 gap-1.5">
          {THINKING_OPTIONS.map((opt) => {
            const active = form.thinkingEffort === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  setForm((f) => ({ ...f, thinkingEffort: opt.value }))
                }
                title={opt.hint}
                className={`px-2 py-1.5 rounded-lg text-xs transition-colors ${
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
                {opt.label}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {THINKING_OPTIONS.find((o) => o.value === form.thinkingEffort)?.hint}
        </p>
      </div>

      <SectionDivider />

      <p className="text-xs text-muted-foreground">
        More capabilities (MCP tool execution, Skills) have their own tabs.
      </p>

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
