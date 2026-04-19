import { FileText, AlertTriangle } from 'lucide-react';
import { useAgentMdStore } from '@/store/agentMdStore';

/**
 * Phase E · tiny chip next to the input indicating whether project-level
 * memory was picked up. Hidden entirely when there is no workspace root or
 * no AGENT.md in it — an absence is not interesting to surface.
 *
 * Clicking refreshes from disk. A full editor lives in Settings (future).
 */
export function AgentMdChip() {
  const payload = useAgentMdStore((s) => s.payload);
  const refresh = useAgentMdStore((s) => s.refresh);

  if (!payload.path || !payload.content) return null;

  const shortPath = payload.path.split('/').slice(-2).join('/');

  return (
    <button
      type="button"
      onClick={() => void refresh()}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs
                 bg-card hover:bg-accent transition-colors
                 text-muted-foreground"
      style={{ boxShadow: '0 0 0 1px var(--border)' }}
      title={`Loaded ${payload.path}${
        payload.truncated ? ' (truncated)' : ''
      }. Click to reload from disk.`}
    >
      {payload.truncated ? (
        <AlertTriangle className="size-3.5 text-amber-500" />
      ) : (
        <FileText className="size-3.5" />
      )}
      <span>AGENT.md · {shortPath}</span>
    </button>
  );
}
