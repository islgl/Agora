import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useMcpStore } from '@/store/mcpStore';
import type { McpServerConfig } from '@/types';
import { McpServerForm } from './McpServerForm';

const blankServer = (): McpServerConfig => ({
  id: '',
  name: '',
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  url: '',
  headers: {},
  loginShell: false,
  enabled: true,
  createdAt: 0,
});

export function McpServersList() {
  const { servers, load, remove } = useMcpStore();
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  if (adding || editing) {
    return (
      <McpServerForm
        existing={editing ?? undefined}
        initial={editing ?? blankServer()}
        onClose={() => {
          setEditing(null);
          setAdding(false);
        }}
      />
    );
  }

  const handleDelete = async (s: McpServerConfig) => {
    if (!confirm(`Delete "${s.name}"?`)) return;
    try {
      await remove(s.id);
      toast.success(`Deleted ${s.name}`);
    } catch (e) {
      toast.error(`Delete failed: ${e}`);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2
          className="text-lg text-foreground mb-1"
          style={{ fontFamily: 'Georgia, serif', fontWeight: 500 }}
        >
          MCP servers
        </h2>
        <p className="text-xs text-muted-foreground">
          External tool providers via Model Context Protocol. Supports stdio (local
          process), Streamable HTTP, and legacy SSE.
        </p>
      </div>

      <div className="space-y-2">
        {servers.length === 0 && (
          <div className="text-xs text-muted-foreground py-4">
            No MCP servers configured yet.
          </div>
        )}
        {servers.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-3 p-3 rounded-xl bg-card"
            style={{ boxShadow: '0 0 0 1px var(--border)' }}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-foreground truncate">{s.name}</span>
                {s.enabled ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                    enabled
                  </span>
                ) : (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                    disabled
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {s.transport === 'stdio'
                  ? `${s.command ?? ''} ${s.args.join(' ')}`
                  : s.url ?? ''}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEditing(s)}
              className="text-xs px-2 py-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => void handleDelete(s)}
              className="text-xs px-2 py-1 rounded-md hover:text-destructive hover:bg-destructive/10 text-muted-foreground"
            >
              Delete
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full p-3 rounded-xl border border-dashed border-border
                     text-sm text-muted-foreground hover:border-ring hover:bg-accent hover:text-foreground"
        >
          + Add MCP server
        </button>
      </div>
    </div>
  );
}
