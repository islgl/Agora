import { useMemo } from 'react';
import Plan, {
  type Task,
  type Subtask,
} from '@/components/ui/agent-plan';
import type { MessagePart } from '@/types';

interface AssistantPlanProps {
  parts: MessagePart[];
  /** True while this message is still streaming — the trailing task stays
   *  in-progress. When false, it flips to completed (or failed). */
  streaming: boolean;
}

/**
 * Aggregates the streamed `MessagePart`s of an assistant turn into the
 * Plan component's task/subtask model:
 *
 *   step_start → new Task
 *   thinking   → joined into the current Task's description
 *   tool_call  → new Subtask under the current Task
 *   tool_result / is_error → flips the Subtask status to completed / failed
 *
 * Legacy messages (written before step markers existed) fall back to a
 * single synthetic task so older turns with tool activity still render.
 */
export function AssistantPlan({ parts, streaming }: AssistantPlanProps) {
  const tasks = useMemo(() => derivePlanTasks(parts, streaming), [parts, streaming]);
  if (tasks.length === 0) return null;
  return <Plan tasks={tasks} />;
}

function derivePlanTasks(parts: MessagePart[], streaming: boolean): Task[] {
  const tasks: Task[] = [];
  let stepCounter = 0;

  const ensureTask = (id?: string): Task => {
    if (tasks.length === 0) {
      stepCounter += 1;
      const t: Task = {
        id: id ?? `step-${stepCounter}`,
        title: `Step ${stepCounter}`,
        description: '',
        status: 'in-progress',
        priority: 'medium',
        level: 0,
        dependencies: [],
        subtasks: [],
      };
      tasks.push(t);
    }
    return tasks[tasks.length - 1];
  };

  for (const part of parts) {
    if (part.type === 'step_start') {
      stepCounter += 1;
      const t: Task = {
        id: part.id,
        title: `Step ${stepCounter}`,
        description: '',
        status: 'in-progress',
        priority: 'medium',
        level: 0,
        dependencies: [],
        subtasks: [],
      };
      tasks.push(t);
      continue;
    }
    if (part.type === 'thinking') {
      const t = ensureTask();
      t.description = (t.description ? t.description + '\n' : '') + part.text;
      continue;
    }
    if (part.type === 'tool_call') {
      const t = ensureTask();
      const existing = t.subtasks.find((s) => s.id === part.id);
      if (!existing) {
        const sub: Subtask = {
          id: part.id,
          title: part.name,
          description: formatToolArgs(part.input, part.inputPartial),
          status: 'in-progress',
          priority: 'medium',
          tools: [part.name],
        };
        t.subtasks.push(sub);
      } else {
        existing.description = formatToolArgs(part.input, part.inputPartial);
      }
      continue;
    }
    if (part.type === 'tool_result') {
      const owner = tasks.find((t) => t.subtasks.some((s) => s.id === part.call_id));
      const sub = owner?.subtasks.find((s) => s.id === part.call_id);
      if (sub) {
        sub.status = part.is_error ? 'failed' : 'completed';
        const snippet = truncate(part.content, 400);
        sub.description = sub.description
          ? `${sub.description}\n---\n${snippet}`
          : snippet;
      }
      continue;
    }
    // text parts are rendered by MessageBubble separately; ignore here.
  }

  if (tasks.length === 0) return tasks;

  // Older tasks with any subtask activity are "done" in the plan sense —
  // only the trailing task tracks the live status.
  for (let i = 0; i < tasks.length - 1; i++) {
    tasks[i].status = summarizeTaskStatus(tasks[i], false);
  }
  const last = tasks[tasks.length - 1];
  last.status = summarizeTaskStatus(last, streaming);

  return tasks;
}

function summarizeTaskStatus(task: Task, isTrailingAndStreaming: boolean): string {
  const hasFail = task.subtasks.some((s) => s.status === 'failed');
  if (hasFail) return 'failed';
  if (isTrailingAndStreaming) return 'in-progress';
  const allDone =
    task.subtasks.length === 0
      ? true
      : task.subtasks.every((s) => s.status === 'completed');
  return allDone ? 'completed' : 'in-progress';
}

function formatToolArgs(input: unknown, inputPartial?: string): string {
  if (input && typeof input === 'object' && Object.keys(input as object).length > 0) {
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }
  return inputPartial?.trim() ? inputPartial : '';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
