import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { useSettingsStore } from '@/store/settingsStore';
import { SectionDivider } from './SectionDivider';
import type { AutoTitleMode, GlobalSettings } from '@/types';

const AUTO_TITLE_OPTIONS: { value: AutoTitleMode; label: string; hint: string }[] = [
  {
    value: 'every',
    label: 'Every turn',
    hint: 'Refresh the title as the conversation evolves. Costs a small extra call per turn.',
  },
  {
    value: 'first',
    label: 'After first turn',
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

  const dirty =
    form.autoTitleMode !== globalSettings.autoTitleMode ||
    form.workspaceRoot !== globalSettings.workspaceRoot ||
    form.autoApproveReadonly !== globalSettings.autoApproveReadonly;

  const pickWorkspace = async () => {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: form.workspaceRoot || undefined,
        title: 'Select workspace root',
      });
      if (typeof picked === 'string' && picked) {
        setForm((f) => ({ ...f, workspaceRoot: picked }));
      }
    } catch (err) {
      toast.error(`Picker failed: ${String(err)}`);
    }
  };

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
        <div className="grid grid-cols-3 gap-2">
          {AUTO_TITLE_OPTIONS.map((opt) => {
            const active = form.autoTitleMode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  setForm((f) => ({ ...f, autoTitleMode: opt.value }))
                }
                title={opt.hint}
                className={`px-3 py-2 rounded-xl text-center text-sm transition-colors ${
                  active
                    ? 'bg-primary/5 text-primary'
                    : 'bg-card hover:bg-accent/40 text-foreground'
                }`}
                style={{
                  boxShadow: active
                    ? '0 0 0 1px color-mix(in oklab, var(--primary) 35%, transparent)'
                    : '0 0 0 1px var(--border)',
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Hover an option for details. If you rename a conversation yourself, auto-title stops touching it.
        </p>
      </div>

      <SectionDivider />

      <div className="space-y-2">
        <Label className="text-sm text-muted-foreground">Workspace root</Label>
        <p className="text-[11px] text-muted-foreground">
          Built-in tools (read_file, glob, grep, write_file, bash) resolve
          relative paths against this directory. Leave blank to require
          absolute paths.
        </p>
        <div className="flex items-center gap-2">
          <Input
            value={form.workspaceRoot}
            onChange={(e) =>
              setForm((f) => ({ ...f, workspaceRoot: e.target.value }))
            }
            placeholder="No workspace selected"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className="flex-1 min-w-0 h-9 rounded-xl text-xs"
            title={form.workspaceRoot || '(none)'}
          />
          <button
            type="button"
            onClick={pickWorkspace}
            className="px-3 py-2 rounded-xl text-xs bg-card hover:bg-accent
                       flex items-center gap-1.5 text-foreground"
            style={{ boxShadow: '0 0 0 1px var(--border)' }}
          >
            <FolderOpen className="size-3.5" />
            Choose…
          </button>
          {form.workspaceRoot && (
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, workspaceRoot: '' }))}
              className="px-2 py-2 rounded-xl text-xs text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div
        className="flex items-start gap-3 p-3 rounded-xl bg-card"
        style={{ boxShadow: '0 0 0 1px var(--border)' }}
      >
        <div className="space-y-0.5 flex-1 min-w-0">
          <div className="text-sm text-foreground">Auto-approve read-only tools</div>
          <div className="text-xs text-muted-foreground">
            Lets the agent call <code>read_file</code>, <code>glob</code>,{' '}
            <code>grep</code>, and <code>read_task_output</code> without asking.
            Write / exec tools always prompt unless you save an allow rule.
          </div>
        </div>
        <Toggle
          checked={form.autoApproveReadonly}
          onCheckedChange={(checked) =>
            setForm((f) => ({ ...f, autoApproveReadonly: checked }))
          }
          className="mt-0.5"
        />
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
