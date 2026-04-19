import { useMemo } from 'react';
import Plan, { type Task } from '@/components/ui/agent-plan';
import { useChatStore } from '@/store/chatStore';
import type { Todo } from '@/types';

interface ConversationTodosProps {
  conversationId: string;
}

/**
 * Conversation-scoped Plan view driven by `todo_write` tool calls. When the
 * model has not used `todo_write`, the store holds `[]` and this component
 * renders nothing — the per-message `AssistantPlan` remains as the fallback.
 */
export function ConversationTodos({ conversationId }: ConversationTodosProps) {
  const todos = useChatStore((s) => s.todos[conversationId]);
  const tasks = useMemo(() => todosToTasks(todos ?? []), [todos]);
  if (tasks.length === 0) return null;
  return (
    <div className="mb-3" data-slot="conversation-todos">
      <Plan tasks={tasks} />
    </div>
  );
}

function todosToTasks(todos: Todo[]): Task[] {
  return todos.map((t) => ({
    id: t.id,
    title: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content,
    description: t.activeForm && t.activeForm !== t.content ? t.content : '',
    status: toPlanStatus(t.status),
    priority: 'medium',
    level: 0,
    dependencies: [],
    subtasks: [],
  }));
}

function toPlanStatus(status: Todo['status']): string {
  switch (status) {
    case 'in_progress':
      return 'in-progress';
    case 'blocked':
      return 'need-help';
    case 'completed':
      return 'completed';
    case 'pending':
    default:
      return 'pending';
  }
}
