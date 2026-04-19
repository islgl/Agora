import { useMemo } from 'react';
import Plan, { type Task } from '@/components/ui/agent-plan';

interface AgentPlanBlockProps {
  /** Raw JSON body from the ```agent-plan fenced code block. */
  code: string;
}

/**
 * Render a `Plan` from a fenced code block emitted by the model. Accepts
 * either `{ tasks: [...] }` or a bare `[...]`; anything else falls back
 * to showing the raw source so streaming-in-progress code doesn't flash
 * an error.
 */
export function AgentPlanBlock({ code }: AgentPlanBlockProps) {
  const parsed = useMemo(() => tryParseTasks(code), [code]);

  if (!parsed) {
    return (
      <pre className="my-3 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground whitespace-pre-wrap">
        {code || 'agent-plan: waiting for data…'}
      </pre>
    );
  }

  return (
    <div className="my-3">
      <Plan tasks={parsed} />
    </div>
  );
}

function tryParseTasks(code: string): Task[] | null {
  const trimmed = code.trim();
  if (!trimmed) return null;
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const maybe = (data as { tasks?: unknown })?.tasks ?? data;
  if (!Array.isArray(maybe)) return null;
  const tasks: Task[] = [];
  for (const raw of maybe) {
    const t = coerceTask(raw);
    if (t) tasks.push(t);
  }
  return tasks.length ? tasks : null;
}

function coerceTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.title !== 'string') return null;
  const subtasksRaw = Array.isArray(r.subtasks) ? r.subtasks : [];
  const subtasks = subtasksRaw
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const sr = s as Record<string, unknown>;
      if (typeof sr.id !== 'string' || typeof sr.title !== 'string') return null;
      return {
        id: sr.id,
        title: sr.title,
        description: typeof sr.description === 'string' ? sr.description : '',
        status: typeof sr.status === 'string' ? sr.status : 'pending',
        priority: typeof sr.priority === 'string' ? sr.priority : 'medium',
        tools:
          Array.isArray(sr.tools) && sr.tools.every((t) => typeof t === 'string')
            ? (sr.tools as string[])
            : undefined,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return {
    id: r.id,
    title: r.title,
    description: typeof r.description === 'string' ? r.description : '',
    status: typeof r.status === 'string' ? r.status : 'pending',
    priority: typeof r.priority === 'string' ? r.priority : 'medium',
    level: typeof r.level === 'number' ? r.level : 0,
    dependencies:
      Array.isArray(r.dependencies) &&
      r.dependencies.every((d) => typeof d === 'string')
        ? (r.dependencies as string[])
        : [],
    subtasks,
  };
}
