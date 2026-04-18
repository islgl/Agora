import { useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { useMcpStore } from '@/store/mcpStore';
import type { McpServerConfig, McpTransport } from '@/types';

const INPUT_CLASS =
  'rounded-xl border-border bg-card text-foreground focus-visible:border-ring focus-visible:ring-0 placeholder:text-muted-foreground';

interface McpServerFormProps {
  existing?: McpServerConfig;
  initial: McpServerConfig;
  onClose: () => void;
}

const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse'];

export function McpServerForm({ existing, initial, onClose }: McpServerFormProps) {
  const { save, test } = useMcpStore();
  const [form, setForm] = useState<McpServerConfig>(initial);
  const [argsText, setArgsText] = useState(initial.args.join('\n'));
  const [envText, setEnvText] = useState(
    Object.entries(initial.env).map(([k, v]) => `${k}=${v}`).join('\n')
  );
  const [headersText, setHeadersText] = useState(
    Object.entries(initial.headers).map(([k, v]) => `${k}=${v}`).join('\n')
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const buildServer = (): McpServerConfig => ({
    ...form,
    args: argsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    env: parseKeyValue(envText),
    headers: parseKeyValue(headersText),
  });

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await save(buildServer());
      toast.success(existing ? `Updated ${form.name}` : `Added ${form.name}`);
      onClose();
    } catch (err) {
      toast.error(`Save failed: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const count = await test(buildServer());
      toast.success(`Connected — ${count} tool(s) available`);
    } catch (err) {
      toast.error(`Connection failed: ${err}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg text-foreground" style={{ fontFamily: 'Georgia, serif', fontWeight: 500 }}>
          {existing ? 'Edit MCP server' : 'Add MCP server'}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="text-xs px-2 py-1 rounded-md hover:bg-accent text-muted-foreground"
        >
          ← Back
        </button>
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm text-muted-foreground">Display name</Label>
        <Input
          className={INPUT_CLASS}
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="filesystem"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm text-muted-foreground">Transport</Label>
        <div className="grid grid-cols-3 gap-2">
          {TRANSPORTS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setForm((f) => ({ ...f, transport: t }))}
              className={`px-3 py-2 rounded-xl text-sm ${
                form.transport === t
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card text-muted-foreground hover:text-foreground'
              }`}
              style={form.transport !== t ? { boxShadow: '0 0 0 1px var(--border)' } : {}}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {form.transport === 'stdio' && (
        <>
          <div className="space-y-1.5">
            <Label className="text-sm text-muted-foreground">Command</Label>
            <Input
              className={INPUT_CLASS}
              value={form.command ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
              placeholder="npx"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm text-muted-foreground">Arguments (one per line)</Label>
            <textarea
              className={`${INPUT_CLASS} min-h-20 w-full p-2 text-sm resize-y`}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/tmp'}
              style={{ boxShadow: '0 0 0 1px var(--border)' }}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm text-muted-foreground">Environment (KEY=VALUE per line)</Label>
            <textarea
              className={`${INPUT_CLASS} min-h-16 w-full p-2 text-sm resize-y`}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              style={{ boxShadow: '0 0 0 1px var(--border)' }}
            />
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Toggle
              checked={form.loginShell}
              onCheckedChange={(checked) =>
                setForm((f) => ({ ...f, loginShell: checked }))
              }
            />
            <span>
              Run under login shell (inherits PATH from your .zshrc/.bashrc; fixes nvm /
              pyenv / homebrew on macOS)
            </span>
          </div>
        </>
      )}

      {form.transport !== 'stdio' && (
        <>
          <div className="space-y-1.5">
            <Label className="text-sm text-muted-foreground">URL</Label>
            <Input
              className={INPUT_CLASS}
              value={form.url ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              placeholder="http://localhost:8000/mcp"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm text-muted-foreground">Headers (KEY=VALUE per line)</Label>
            <textarea
              className={`${INPUT_CLASS} min-h-16 w-full p-2 text-sm resize-y`}
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              style={{ boxShadow: '0 0 0 1px var(--border)' }}
            />
          </div>
        </>
      )}

      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Toggle
          checked={form.enabled}
          onCheckedChange={(checked) =>
            setForm((f) => ({ ...f, enabled: checked }))
          }
        />
        <span>Enabled</span>
      </div>

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={testing}
          className="px-4 py-2 rounded-xl bg-card text-foreground text-sm disabled:opacity-60"
          style={{ boxShadow: '0 0 0 1px var(--border)' }}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>
    </form>
  );
}

function parseKeyValue(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}
