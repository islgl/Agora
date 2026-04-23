import { useMemo, useState } from 'react';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  X,
  ChevronDown,
  ChevronRight,
  Wrench,
  Brain,
  MessageSquare,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSubagentsStore, type SubagentView } from '@/store/subagentsStore';
import {
  stopSubagent,
  snapshotSubagent,
  type SubagentEvent,
} from '@/lib/ai/subagent';

/**
 * Compact chip above the ChatInput. Shows a live count of running subagents
 * and expands into a popover listing each one with its preview + stop button.
 * Hidden entirely when no subagents have been spawned this session.
 */
export function SubagentsIndicator() {
  const tasks = useSubagentsStore((s) => s.tasks);
  const clearFinished = useSubagentsStore((s) => s.clearFinished);

  const ordered = useMemo(
    () =>
      Object.values(tasks).sort((a, b) => b.startedAt - a.startedAt),
    [tasks],
  );
  const running = ordered.filter((t) => t.status === 'running');

  if (ordered.length === 0) return null;

  const label = running.length
    ? `${running.length} subagent${running.length === 1 ? '' : 's'} running`
    : `${ordered.length} subagent${ordered.length === 1 ? '' : 's'}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs
                   bg-card hover:bg-accent transition-colors
                   text-muted-foreground"
        style={{ boxShadow: '0 0 0 1px var(--border)' }}
        title={label}
      >
        {running.length > 0 ? (
          <Loader2 className="size-3.5 animate-spin text-blue-500" />
        ) : (
          <CheckCircle2 className="size-3.5 text-muted-foreground" />
        )}
        <span>{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[22rem] p-0 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-foreground">Subagents</span>
          {running.length === 0 && (
            <button
              type="button"
              onClick={() => clearFinished()}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
        <ul className="max-h-80 overflow-y-auto">
          {ordered.map((task) => (
            <li key={task.id}>
              <SubagentRow task={task} />
            </li>
          ))}
        </ul>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SubagentRow({ task }: { task: SubagentView }) {
  const { icon, label } = STATUS_META[task.status];
  const [expanded, setExpanded] = useState(false);
  const duration = task.endedAt
    ? `${((task.endedAt - task.startedAt) / 1000).toFixed(1)}s`
    : `${((Date.now() - task.startedAt) / 1000).toFixed(0)}s elapsed`;
  // Pull events fresh on every render — task.eventCount changes bump our
  // parent re-renders, so this stays in sync with the module-level log.
  const snap = expanded ? snapshotSubagent(task.id) : null;
  const events = snap?.events ?? [];
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-3 py-2.5 hover:bg-accent/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="shrink-0">{icon}</span>
          <span className="text-sm font-medium text-foreground truncate flex-1">
            {task.description}
          </span>
          {task.status === 'running' && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                stopSubagent(task.id);
              }}
              className="shrink-0 text-muted-foreground hover:text-destructive"
              aria-label="Stop subagent"
              title="Stop"
            >
              <X className="size-3.5" />
            </button>
          )}
          <ChevronDown
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
              expanded ? 'rotate-180' : ''
            }`}
          />
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{label}</span>
          <span>·</span>
          <span>{duration}</span>
          <span>·</span>
          <span>{task.eventCount} events</span>
          <span>·</span>
          <span className="font-mono truncate">{task.id.slice(0, 8)}</span>
        </div>
        {task.error ? (
          <p className="mt-1 text-[11px] text-destructive">{task.error}</p>
        ) : task.outputPreview ? (
          <p className="mt-1 text-[11px] text-muted-foreground line-clamp-3 whitespace-pre-wrap">
            {task.outputPreview}
          </p>
        ) : null}
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-1.5">
          {events.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">
              No events recorded yet.
            </p>
          ) : (
            events.map((ev, i) => <EventRow key={i} event={ev} />)
          )}
        </div>
      )}
    </div>
  );
}

function EventRow({ event }: { event: SubagentEvent }) {
  if (event.kind === 'reasoning') {
    return (
      <div className="flex items-start gap-1.5 text-[11px]">
        <Brain className="size-3 mt-0.5 shrink-0 text-muted-foreground" />
        <p className="flex-1 text-muted-foreground italic whitespace-pre-wrap line-clamp-6">
          {event.text}
        </p>
      </div>
    );
  }
  if (event.kind === 'text') {
    return (
      <div className="flex items-start gap-1.5 text-[11px]">
        <MessageSquare className="size-3 mt-0.5 shrink-0 text-muted-foreground" />
        <p className="flex-1 text-foreground whitespace-pre-wrap line-clamp-6">
          {event.text}
        </p>
      </div>
    );
  }
  if (event.kind === 'tool-call') {
    return (
      <div className="flex items-start gap-1.5 text-[11px]">
        <Wrench className="size-3 mt-0.5 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-foreground truncate">
            {event.toolName}
          </div>
          <pre
            className="mt-0.5 p-1.5 rounded text-[10px] overflow-x-auto whitespace-pre-wrap break-all font-mono"
            style={{
              background: 'color-mix(in oklab, var(--muted) 50%, transparent)',
            }}
          >
            {tryStringify(event.input)}
          </pre>
        </div>
      </div>
    );
  }
  // tool-result
  return (
    <div className="flex items-start gap-1.5 text-[11px] ml-4">
      <span
        className={`shrink-0 inline-flex items-center ${
          event.isError ? 'text-destructive' : 'text-emerald-500'
        }`}
      >
        {event.isError ? (
          <X aria-hidden className="size-3" />
        ) : (
          <ChevronRight aria-hidden className="size-3" />
        )}
      </span>
      <pre
        className="flex-1 p-1.5 rounded text-[10px] overflow-x-auto whitespace-pre-wrap break-all font-mono"
        style={{
          background: event.isError
            ? 'color-mix(in oklab, var(--destructive) 10%, transparent)'
            : 'color-mix(in oklab, var(--muted) 40%, transparent)',
          color: event.isError ? 'var(--destructive)' : undefined,
        }}
      >
        {truncateText(event.output, 400)}
      </pre>
    </div>
  );
}

function tryStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… (${s.length - max} more chars)`;
}

const STATUS_META: Record<
  SubagentView['status'],
  { icon: React.ReactNode; label: string }
> = {
  running: {
    icon: <Loader2 className="size-3.5 animate-spin text-blue-500" />,
    label: 'running',
  },
  completed: {
    icon: <CheckCircle2 className="size-3.5 text-emerald-500" />,
    label: 'completed',
  },
  failed: {
    icon: <XCircle className="size-3.5 text-destructive" />,
    label: 'failed',
  },
  cancelled: {
    icon: <Ban className="size-3.5 text-muted-foreground" />,
    label: 'cancelled',
  },
};
