import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { useSettingsStore } from '@/store/settingsStore';
import { SectionDivider } from './SectionDivider';
import type { AutoTitleMode, GlobalSettings } from '@/types';

const AUTO_TITLE_OPTIONS: { value: AutoTitleMode; label: string; hint: string }[] = [
  {
    value: 'every',
    label: 'Update on every turn',
    hint: 'Refresh the title as the conversation evolves. Costs a small extra call per turn.',
  },
  {
    value: 'first',
    label: 'Only after first turn',
    hint: 'Summarize once when the first exchange completes. Cheaper and stable.',
  },
  {
    value: 'off',
    label: 'Off',
    hint: 'Keep the auto-generated "first 40 chars" title. You can rename manually anytime.',
  },
];

export function GeneralForm() {
  const { globalSettings, saveGlobalSettings } = useSettingsStore();
  const [form, setForm] = useState<GlobalSettings>(globalSettings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(globalSettings);
  }, [globalSettings]);

  const dirty = form.autoTitleMode !== globalSettings.autoTitleMode;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await saveGlobalSettings(form);
      toast.success('General settings saved');
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-2">
        <Label className="text-sm text-muted-foreground">Auto conversation title</Label>
        <div className="space-y-2">
          {AUTO_TITLE_OPTIONS.map((opt) => {
            const active = form.autoTitleMode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  setForm((f) => ({ ...f, autoTitleMode: opt.value }))
                }
                className={`w-full text-left flex items-start gap-3 p-3 rounded-xl transition-colors ${
                  active
                    ? 'bg-primary/5'
                    : 'bg-card hover:bg-accent/40'
                }`}
                style={{
                  boxShadow: active
                    ? '0 0 0 1px color-mix(in oklab, var(--primary) 35%, transparent)'
                    : '0 0 0 1px var(--border)',
                }}
              >
                <span
                  className={`mt-0.5 size-3.5 shrink-0 rounded-full ${
                    active ? 'bg-primary' : 'bg-transparent'
                  }`}
                  style={{
                    boxShadow: active
                      ? '0 0 0 1px var(--primary)'
                      : '0 0 0 1px var(--border)',
                  }}
                />
                <div className="space-y-0.5 min-w-0">
                  <div
                    className={`text-sm ${
                      active ? 'text-primary' : 'text-foreground'
                    }`}
                  >
                    {opt.label}
                  </div>
                  <div className="text-xs text-muted-foreground">{opt.hint}</div>
                </div>
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">
          If you rename a conversation yourself, auto-title stops touching it.
        </p>
      </div>

      <SectionDivider />

      <p className="text-xs text-muted-foreground">
        More preferences will live here as the app grows.
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
