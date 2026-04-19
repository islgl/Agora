import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Webhook } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { useSettingsStore } from '@/store/settingsStore';
import { SectionDivider } from './SectionDivider';

const EXAMPLE = `{
  "preToolUse": [
    {
      "matcher": "bash",
      "command": "echo \\"$(date -u +%FT%TZ) bash: $TOOL_INPUT\\" >> ~/.agora/audit.log",
      "failMode": "warn"
    }
  ],
  "postToolUse": [
    {
      "matcher": "*",
      "command": "printf '%s\\\\n' \\"$TOOL_NAME\\" >> ~/.agora/tool-usage.log"
    }
  ]
}`;

/**
 * Phase E · JSON-edited hooks configuration.
 *
 * Kept deliberately minimal for MVP — a textarea with parse validation and
 * a save button. A full schema-driven editor is possible later, but most
 * users who want hooks are comfortable with JSON and a shell snippet.
 */
export function HooksForm() {
  const { globalSettings, saveGlobalSettings } = useSettingsStore();
  const [text, setText] = useState<string>(globalSettings.hooksJson || '{}');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setText(globalSettings.hooksJson || '{}');
  }, [globalSettings.hooksJson]);

  const dirty = text !== (globalSettings.hooksJson || '{}');

  const handleChange = (value: string) => {
    setText(value);
    if (value.trim() === '') {
      setError(null);
      return;
    }
    try {
      JSON.parse(value);
      setError(null);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const handleSave = async () => {
    if (error) return;
    setSaving(true);
    try {
      const normalized = text.trim() === '' ? '{}' : text;
      await saveGlobalSettings({ ...globalSettings, hooksJson: normalized });
      toast.success('Hooks saved');
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Webhook className="size-4 text-primary" />
          <h2
            className="text-base text-foreground"
            style={{ fontFamily: 'Georgia, serif', fontWeight: 500 }}
          >
            Tool-use hooks
          </h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Run shell commands around every tool call. Supported events:{' '}
          <code>preToolUse</code> (before the call; <code>block</code> fail
          mode cancels the call), <code>postToolUse</code> (after; fail modes
          only warn). Matcher is an exact tool name or <code>*</code> for
          any. Each command gets <code>HOOK_EVENT</code>,{' '}
          <code>TOOL_NAME</code>, <code>TOOL_INPUT</code> and (post-only)
          <code>TOOL_OUTPUT</code> as env vars. 15-second per-hook timeout.
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm text-muted-foreground">Config (JSON)</Label>
        <textarea
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={EXAMPLE}
          spellCheck={false}
          className="w-full h-72 font-mono text-xs rounded-xl px-3 py-2
                     bg-card text-foreground focus:outline-none focus:ring-0"
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
        />
        {error ? (
          <p className="text-[11px] text-destructive font-mono">{error}</p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Leave empty or <code>{'{}'}</code> to disable all hooks.
          </p>
        )}
      </div>

      <SectionDivider />

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer text-foreground">
          Example config
        </summary>
        <pre
          className="mt-2 p-3 rounded-xl bg-card font-mono whitespace-pre-wrap"
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
        >
          {EXAMPLE}
        </pre>
      </details>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving || Boolean(error)}
          className="px-4 py-2 rounded-xl text-sm text-primary-foreground bg-primary
                     hover:bg-primary/90 transition-colors
                     disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ boxShadow: '0 0 0 1px var(--primary)' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
