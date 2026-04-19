import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ShieldCheck, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { usePermissionsStore } from '@/store/permissionsStore';
import { SectionDivider } from './SectionDivider';

const INPUT_CLASS =
  'rounded-xl border-border bg-card text-foreground focus-visible:border-ring focus-visible:ring-0 placeholder:text-muted-foreground';

/** Tools the agent can request permission for. Keep in sync with the Rust
 *  `BuiltinKind` list — if the backend gains a new gated tool, add it here. */
const TOOL_CHOICES = [
  'bash',
  'bash_background',
  'write_file',
  'edit_file',
  'read_file',
  'glob',
  'grep',
  'stop_task',
  'read_task_output',
] as const;

export function PermissionsForm() {
  const permissions = usePermissionsStore((s) => s.permissions);
  const loadPermissions = usePermissionsStore((s) => s.loadPermissions);
  const savePermission = usePermissionsStore((s) => s.savePermission);
  const deletePermission = usePermissionsStore((s) => s.deletePermission);

  const [tool, setTool] = useState<string>('bash');
  const [pattern, setPattern] = useState<string>('');
  const [decision, setDecision] = useState<'allow' | 'deny'>('allow');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadPermissions();
  }, [loadPermissions]);

  const sortedRules = useMemo(
    () =>
      [...permissions].sort(
        (a, b) =>
          a.toolName.localeCompare(b.toolName) ||
          a.pattern.localeCompare(b.pattern),
      ),
    [permissions],
  );

  const patternHint =
    tool === 'bash' || tool === 'bash_background'
      ? 'Glob against the shell command. E.g. `git *` matches `git status`, `git log …`.'
      : 'Glob against the target path. E.g. `src/**` matches any file under src.';

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await savePermission({ toolName: tool, pattern, decision });
      toast.success(
        `${decision === 'allow' ? 'Allowed' : 'Denied'} ${tool}${
          pattern ? ` ${pattern}` : ''
        }`,
      );
      setPattern('');
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, label: string) => {
    if (!window.confirm(`Remove rule "${label}"?`)) return;
    try {
      await deletePermission(id);
    } catch (err) {
      toast.error(String(err));
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" />
          <h2
            className="text-base text-foreground"
            style={{ fontFamily: 'Georgia, serif', fontWeight: 500 }}
          >
            Tool permissions
          </h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Persistent allow/deny rules for built-in tools. The agent asks before
          every unmatched mutating call; save an "Always" choice here (or add
          rules below) so routine commands stop interrupting you. Deny rules
          always win over allow rules.
        </p>
      </div>

      <form
        onSubmit={handleAdd}
        className="space-y-3 p-3 rounded-xl bg-card"
        style={{ boxShadow: '0 0 0 1px var(--border)' }}
      >
        <div className="grid gap-3 sm:grid-cols-[9rem,1fr,8rem,auto] items-end">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Tool</Label>
            <select
              value={tool}
              onChange={(e) => setTool(e.target.value)}
              className={`${INPUT_CLASS} h-9 w-full px-2 text-sm`}
              style={{ boxShadow: '0 0 0 1px var(--border)' }}
            >
              {TOOL_CHOICES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              Pattern (empty = any)
            </Label>
            <Input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder={
                tool === 'bash' || tool === 'bash_background'
                  ? 'git *'
                  : 'src/**'
              }
              className={INPUT_CLASS}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Decision</Label>
            <div className="flex rounded-xl overflow-hidden" style={{ boxShadow: '0 0 0 1px var(--border)' }}>
              <button
                type="button"
                onClick={() => setDecision('allow')}
                className={`flex-1 text-xs py-2 transition-colors ${
                  decision === 'allow'
                    ? 'bg-primary/10 text-primary'
                    : 'bg-card text-muted-foreground hover:text-foreground'
                }`}
              >
                Allow
              </button>
              <button
                type="button"
                onClick={() => setDecision('deny')}
                className={`flex-1 text-xs py-2 transition-colors ${
                  decision === 'deny'
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-card text-muted-foreground hover:text-foreground'
                }`}
              >
                Deny
              </button>
            </div>
          </div>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? 'Saving…' : 'Add rule'}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">{patternHint}</p>
      </form>

      <SectionDivider />

      <div className="space-y-2">
        <Label className="text-sm text-muted-foreground">
          Saved rules ({sortedRules.length})
        </Label>
        {sortedRules.length === 0 ? (
          <div
            className="p-3 rounded-xl text-xs text-muted-foreground bg-card"
            style={{ boxShadow: '0 0 0 1px var(--border)' }}
          >
            No rules yet. Approve a tool call with "Always" — or add one above.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {sortedRules.map((rule) => {
              const label = `${rule.toolName}${rule.pattern ? ` ${rule.pattern}` : ''}`;
              const isDeny = rule.decision === 'deny';
              return (
                <li
                  key={rule.id}
                  className="flex items-center gap-2 p-2.5 rounded-xl bg-card"
                  style={{ boxShadow: '0 0 0 1px var(--border)' }}
                >
                  <span
                    className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${
                      isDeny
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-primary/10 text-primary'
                    }`}
                  >
                    {isDeny ? 'deny' : 'allow'}
                  </span>
                  <span className="font-mono text-xs text-foreground shrink-0">
                    {rule.toolName}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground truncate flex-1 min-w-0">
                    {rule.pattern || '(any)'}
                  </span>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {new Date(rule.createdAt).toLocaleDateString()}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDelete(rule.id, label)}
                    className="text-muted-foreground hover:text-destructive shrink-0"
                    aria-label={`Delete rule ${label}`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
