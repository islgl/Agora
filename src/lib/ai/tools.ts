import { invoke } from '@tauri-apps/api/core';
import { jsonSchema, tool, type ToolSet } from 'ai';
import type {
  ConversationMode,
  PermissionCheckResult,
  Todo,
  TodoStatus,
} from '@/types';
import {
  defaultPatternFor,
  requestApproval,
} from '@/lib/ai/approval-broker';
import { usePermissionsStore } from '@/store/permissionsStore';
import { useChatStore } from '@/store/chatStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  spawnSubagent,
  snapshotSubagent,
  stopSubagent,
  listSubagents,
  type SubagentSnapshot,
} from '@/lib/ai/subagent';
import { requestAskUser } from '@/lib/ai/ask-user-broker';

/**
 * Bridge between the Vercel AI SDK and the Rust-owned tool runtimes
 * (MCP servers + Skill built-ins + first-class built-ins).
 *
 * The SDK sees a normal `ToolSet`; `execute()` forwards to Rust via
 * `invoke('invoke_tool', ...)`. Tool *definitions* (name, description,
 * JSON schema) come straight from `list_frontend_tools`, so we never have
 * to mirror each MCP tool on the TS side.
 *
 * Built-in tools (FS / Bash) pass through the permission gate before Rust
 * ever sees the call. MCP and Skill tools are not gated today — if they
 * grow destructive capabilities, extend `isGatedTool` below.
 */

interface ToolSpecDto {
  name: string;
  description: string;
  inputSchema: unknown;
  source?: { type?: string } | unknown;
}

interface ToolInvocationResult {
  content: string;
  isError: boolean;
}

const BUILTIN_NAMES = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'bash',
  'bash_background',
  'read_task_output',
  'stop_task',
]);

/** Mutating / process-spawning built-ins. Exposed to the model in every
 *  mode (so the schema stays stable turn-over-turn), but runtime-gated in
 *  `executeToolCall` — calling one while the conversation is still in
 *  `plan` mode returns an error instead of executing. This way a model
 *  that called `exit_plan_mode` mid-turn can immediately use the write
 *  tools without waiting for the next turn's toolset reload. */
const PLAN_MODE_BLOCKLIST = new Set([
  'write_file',
  'edit_file',
  'bash',
  'bash_background',
  'stop_task',
]);

/** Same list, plus anything else a subagent shouldn't touch. Subagents are
 *  MVP-scoped to investigative tasks — they cannot mutate the filesystem,
 *  spawn shells, or (via `task`) fan out further. */
const SUBAGENT_BLOCKLIST = new Set([
  ...PLAN_MODE_BLOCKLIST,
  // Drop the synthesized tools; subagents shouldn't manage the parent's
  // plan, flip modes, spawn their own subagents, or prompt the user.
  'todo_write',
  'task',
  'read_subagent_output',
  'stop_subagent',
  'list_subagents',
  'enter_plan_mode',
  'exit_plan_mode',
  'ask_user',
]);

function isGatedTool(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

/** Current conversation's mode, read fresh from the store so mid-turn
 *  flips via `enter_plan_mode` / `exit_plan_mode` take effect immediately. */
function currentConversationMode(): ConversationMode {
  const store = useChatStore.getState();
  const conv = store.conversations.find(
    (c) => c.id === store.currentConversationId,
  );
  return conv?.mode ?? 'chat';
}

/**
 * Pull the live set of MCP + Skill + built-in tools from Rust and wrap them
 * as AI SDK tools. Returns an empty object if nothing is available so
 * `streamText` happily skips tool handling.
 *
 * `mode` controls which tools are exposed to the model:
 *  - `chat`    — everything, plus `enter_plan_mode`
 *  - `plan`    — readonly built-ins + MCP/Skills + `todo_write` + `exit_plan_mode`
 *                (write/edit/bash stripped entirely)
 *  - `execute` — everything; write/edit get a session-wide allow so the
 *                model isn't interrupted mid-run
 */
export async function loadFrontendTools(
  mode: ConversationMode = 'chat',
): Promise<ToolSet> {
  let specs: ToolSpecDto[] = [];
  try {
    specs = await invoke<ToolSpecDto[]>('list_frontend_tools');
  } catch (err) {
    console.warn('list_frontend_tools failed; running without tools', err);
    return {};
  }

  const set: ToolSet = {};
  for (const spec of specs) {
    set[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(sanitizeSchema(spec.inputSchema)),
      execute: (input: unknown) => executeToolCall(spec.name, input),
    });
  }
  set['todo_write'] = todoWriteTool();

  // Mode-transition tools are runtime-gated too: we expose both
  // regardless of starting mode so a mid-turn switch can still see the
  // other direction if needed, but executing them in the wrong mode
  // returns an error.
  set['enter_plan_mode'] = enterPlanModeTool();
  set['exit_plan_mode'] = exitPlanModeTool();

  set['task'] = taskTool();
  set['read_subagent_output'] = readSubagentOutputTool();
  set['stop_subagent'] = stopSubagentTool();
  set['list_subagents'] = listSubagentsTool();
  set['ask_user'] = askUserTool();

  return set;
}

/**
 * Readonly toolset handed to a subagent. Rebuilt from the same live spec
 * list as the parent's toolset, minus mutating tools and minus subagent
 * synth tools (no recursion).
 */
export async function loadSubagentTools(): Promise<ToolSet> {
  let specs: ToolSpecDto[] = [];
  try {
    specs = await invoke<ToolSpecDto[]>('list_frontend_tools');
  } catch (err) {
    console.warn('list_frontend_tools failed for subagent', err);
    return {};
  }
  const set: ToolSet = {};
  for (const spec of specs) {
    if (SUBAGENT_BLOCKLIST.has(spec.name)) continue;
    set[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(sanitizeSchema(spec.inputSchema)),
      execute: (input: unknown) => executeToolCall(spec.name, input),
    });
  }
  return set;
}

/**
 * Frontend-only tool. The model owns its plan — it emits a full list on each
 * call and we replace-in-place. Storage is per-conversation in chatStore
 * (mirrored to SQLite via `save_todos`). No approval gate: the only side
 * effect is local state.
 */
function todoWriteTool() {
  return tool({
    description:
      'Manage a persistent todo list for the current conversation. Pass the ' +
      'full `todos` array on every call — it replaces the existing list. ' +
      'Use for non-trivial multi-step work: outline the plan up front, flip ' +
      'each todo to `in_progress` when you start it, then `completed` as you ' +
      'finish. Keep exactly one todo `in_progress` at a time.',
    inputSchema: jsonSchema({
      type: 'object',
      required: ['todos'],
      properties: {
        todos: {
          type: 'array',
          description: 'Full replacement todo list.',
          items: {
            type: 'object',
            required: ['id', 'content', 'status'],
            properties: {
              id: { type: 'string', description: 'Stable id across updates.' },
              content: {
                type: 'string',
                description: 'Short imperative — what the step achieves.',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'blocked'],
              },
              activeForm: {
                type: 'string',
                description:
                  'Present-continuous label shown while `in_progress` (e.g. "Running tests"). Optional.',
              },
            },
          },
        },
      },
    }),
    execute: async (input: unknown) => executeTodoWrite(input),
  });
}

async function executeTodoWrite(
  input: unknown,
): Promise<string | { error: string }> {
  const conversationId = useChatStore.getState().currentConversationId;
  if (!conversationId) {
    return { error: 'todo_write requires an active conversation' };
  }
  const parsed = parseTodosInput(input);
  if ('error' in parsed) return parsed;

  try {
    await useChatStore.getState().saveTodos(conversationId, parsed.todos);
  } catch (err) {
    return { error: `save_todos failed: ${String(err)}` };
  }
  const summary = summarizeTodos(parsed.todos);
  return `Todos updated (${parsed.todos.length} total — ${summary}).`;
}

function parseTodosInput(
  input: unknown,
): { todos: Todo[] } | { error: string } {
  if (!input || typeof input !== 'object' || !('todos' in input)) {
    return { error: 'todo_write: expected { todos: Todo[] }' };
  }
  const raw = (input as { todos: unknown }).todos;
  if (!Array.isArray(raw)) {
    return { error: 'todo_write: `todos` must be an array' };
  }
  const todos: Todo[] = [];
  const allowed: TodoStatus[] = [
    'pending',
    'in_progress',
    'completed',
    'blocked',
  ];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return { error: 'todo_write: each todo must be an object' };
    }
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id.trim()) {
      return { error: 'todo_write: todo.id must be a non-empty string' };
    }
    if (typeof r.content !== 'string' || !r.content.trim()) {
      return { error: 'todo_write: todo.content must be a non-empty string' };
    }
    const status = r.status as TodoStatus;
    if (!allowed.includes(status)) {
      return { error: `todo_write: invalid status \`${String(r.status)}\`` };
    }
    todos.push({
      id: r.id,
      content: r.content,
      status,
      activeForm:
        typeof r.activeForm === 'string' && r.activeForm.trim()
          ? r.activeForm
          : undefined,
    });
  }
  return { todos };
}

function summarizeTodos(todos: Todo[]): string {
  const counts: Record<TodoStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
  };
  for (const t of todos) counts[t.status] += 1;
  const parts: string[] = [];
  if (counts.in_progress) parts.push(`${counts.in_progress} in progress`);
  if (counts.completed) parts.push(`${counts.completed} done`);
  if (counts.pending) parts.push(`${counts.pending} pending`);
  if (counts.blocked) parts.push(`${counts.blocked} blocked`);
  return parts.join(', ') || 'empty';
}

/**
 * Agent-driven mode switches. The user can always toggle mode from the UI;
 * these tools give the *model* the same lever so it can proactively enter
 * plan mode when it notices a request calls for investigation, or exit once
 * the plan is ready.
 *
 * "Entering execute" is the moment we seed session allows for write/edit —
 * the user already approved the mode switch, so each file write shouldn't
 * re-prompt. Bash stays gated because "arbitrary commands I haven't seen"
 * is a meaningfully worse blast radius than "files inside the workspace".
 */
function enterPlanModeTool() {
  return tool({
    description:
      'Switch the conversation to **plan mode**. In plan mode write_file / ' +
      'edit_file / bash are runtime-gated — attempts error with "not ' +
      'available in plan mode" until you call `exit_plan_mode` and the user ' +
      'approves. Use this when the user asks "how should we approach X", ' +
      'when scoping a refactor, or before any write where the design isn\'t ' +
      'settled yet. Follow with `todo_write` to lay out the plan, then ' +
      '`exit_plan_mode` once ready.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            'Brief (<120 chars) explanation of why plan mode is appropriate. Shown to the user.',
        },
      },
    }),
    execute: async (input: unknown) => switchMode('plan', input),
  });
}

function exitPlanModeTool() {
  return tool({
    description:
      'Request to leave plan mode. Surfaces a confirmation prompt to the ' +
      'user carrying your `summary`; only if they approve does the mode ' +
      'flip back to **chat**. Write tools become callable again but each ' +
      'call still goes through individual approval — this tool grants ' +
      'permission to implement the plan, not blanket write access. If the ' +
      'user wants to skip per-write approvals they can switch to Execute ' +
      'themselves. If they decline, the tool returns an error and you ' +
      'stay in plan mode — revise the plan or ask clarifying questions, ' +
      'do not retry. Call this *only* after the plan is concrete and ' +
      'visible to the user (todo_write list posted, key questions answered).',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'One-paragraph recap of the plan you are about to execute. Shown to the user.',
        },
      },
    }),
    execute: async (input: unknown) => switchMode('chat', input),
  });
}

async function switchMode(
  target: ConversationMode,
  input: unknown,
): Promise<string | { error: string }> {
  const store = useChatStore.getState();
  const conversationId = store.currentConversationId;
  if (!conversationId) {
    return { error: `${target} mode requires an active conversation` };
  }
  const current = store.conversations.find((c) => c.id === conversationId);
  if (!current) {
    return { error: 'conversation not found' };
  }
  if (current.mode === target) {
    return `Already in ${target} mode.`;
  }

  // The synth tools are now exposed in every mode so the schema stays
  // stable, but `exit_plan_mode` only makes sense *from* plan mode. If
  // the model misfires (calls exit_plan_mode while in chat/execute),
  // bail with a clear error. The tool targets `chat` now — writes
  // become callable again but still individually approved; bulk
  // auto-approval is a separate, explicit user choice (chip / /execute).
  if (target === 'chat' && current.mode !== 'plan') {
    return {
      error:
        'exit_plan_mode only applies from plan mode. The conversation is ' +
        `currently in ${current.mode} mode — no mode switch performed.`,
    };
  }

  const note =
    input && typeof input === 'object' && input !== null
      ? (() => {
          const r = input as Record<string, unknown>;
          const text =
            typeof r.reason === 'string'
              ? r.reason
              : typeof r.summary === 'string'
                ? r.summary
                : '';
          return text.trim();
        })()
      : '';

  // Model leaving plan mode → confirm with the user, showing the plan
  // summary. User-driven switches (ModeSelector, `/chat`) go through
  // `setConversationMode` directly and never hit this branch.
  if (current.mode === 'plan' && target === 'chat') {
    const question = note
      ? `Exit plan mode and start implementing?\n\n${note}`
      : 'Exit plan mode and start implementing?';
    const answer = await requestAskUser({
      question,
      options: ['Yes, exit plan mode', 'Stay in plan mode'],
      allowFreeText: false,
    });
    const approved = answer.trim().toLowerCase().startsWith('yes');
    if (!approved) {
      return {
        error:
          'User declined to exit plan mode. Stay in plan mode — ask clarifying questions or revise the plan before trying exit_plan_mode again.',
      };
    }
  }

  // `setConversationMode` owns the session-allow side-effects: it seeds
  // wildcard allows for write_file/edit_file when entering Execute and
  // revokes them when leaving. `bash` is intentionally left out so bash
  // always prompts even in Execute mode.
  try {
    await store.setConversationMode(conversationId, target);
  } catch (err) {
    return { error: `failed to switch mode: ${String(err)}` };
  }

  if (target === 'plan') {
    return (
      `Entered plan mode. Only read tools are available — plan the work with ` +
      `todo_write, then call exit_plan_mode when ready.${
        note ? `\n\nReason: ${note}` : ''
      }`
    );
  }
  if (target === 'chat') {
    return (
      `Left plan mode — conversation is now in chat mode. Write tools are ` +
      `callable again; each call will prompt the user for approval unless ` +
      `an existing permission rule matches. If the user wants to skip those ` +
      `prompts they can switch to Execute mode themselves.${
        note ? `\n\nPlan summary: ${note}` : ''
      }`
    );
  }
  return (
    `Entered execute mode. write_file and edit_file are now session-allowed; ` +
    `bash still asks.${note ? `\n\nPlan summary: ${note}` : ''}`
  );
}

/**
 * `task` — spawn a subagent. The MVP restricts subagents to read-only
 * investigation (see `loadSubagentTools`). Foreground calls (default) wait
 * for the subagent and return its final answer as the tool result;
 * `background: true` returns a task_id immediately so the parent can keep
 * working and check back via `read_subagent_output`.
 */
function taskTool() {
  return tool({
    description:
      'Spawn a read-only investigative subagent in an isolated context. Use ' +
      'when the work needs heavy exploration (grepping the repo, comparing ' +
      'many files, reading docs) that would bloat your own context if done ' +
      'inline. The subagent has read_file / glob / grep / MCP / Skills / web ' +
      'search but cannot write, edit, or run bash. By default (`background` ' +
      'false) you wait for the result; set `background: true` for long ' +
      'investigations — you will get a task_id you can poll with ' +
      'read_subagent_output.',
    inputSchema: jsonSchema({
      type: 'object',
      required: ['description', 'prompt'],
      properties: {
        description: {
          type: 'string',
          description:
            'Short (5-10 word) label shown in the running-subagent chip.',
        },
        prompt: {
          type: 'string',
          description:
            'Self-contained instruction for the subagent. Include everything ' +
            'it needs — it does not see the parent conversation. Ask for a ' +
            'concise report, not raw dumps.',
        },
        background: {
          type: 'boolean',
          description:
            'When true, return task_id immediately. Default false (wait).',
        },
      },
    }),
    execute: async (input: unknown) => executeTaskTool(input),
  });
}

function readSubagentOutputTool() {
  return tool({
    description:
      'Check the current state of a background subagent. Returns {status, ' +
      'output, error?}. Output is the partial text so far when running; the ' +
      'final report when completed. Pass `include_trace: true` to also get ' +
      'the subagent\'s tool-call audit log (each call + result, plus any ' +
      'captured reasoning) — expensive in context, use only when you need ' +
      'to audit HOW it reached its answer, not just the final text.',
    inputSchema: jsonSchema({
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        include_trace: {
          type: 'boolean',
          default: false,
          description:
            'When true, include the subagent\'s event timeline in the output.',
        },
      },
    }),
    execute: async (input: unknown) => executeReadSubagentOutput(input),
  });
}

function stopSubagentTool() {
  return tool({
    description:
      'Cancel a running background subagent. Any partial output is preserved ' +
      'and accessible via read_subagent_output.',
    inputSchema: jsonSchema({
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
      },
    }),
    execute: async (input: unknown) => executeStopSubagent(input),
  });
}

/**
 * `ask_user` — surface a clarification question with clickable options.
 * Use when the next step depends on a user choice that the model can't
 * resolve on its own: ambiguous requirements, destructive action
 * confirmation, picking between equally valid approaches. The UI renders
 * the options as buttons and (optionally) a free-text field; the tool
 * result is whatever the user picked or typed.
 */
function askUserTool() {
  return tool({
    description:
      'Ask the user a clarifying question with 2–6 short options. Use when ' +
      'the request is ambiguous and you need a decision before proceeding; ' +
      'do not use for everyday back-and-forth chatter. Returns the exact ' +
      'text the user picked (one of your options) or typed (free text). ' +
      'Prefer specific, mutually exclusive options. Set allow_free_text to ' +
      'false only when the listed options truly cover every valid answer.',
    inputSchema: jsonSchema({
      type: 'object',
      required: ['question', 'options'],
      properties: {
        question: {
          type: 'string',
          description:
            'The question to ask. One sentence, ends with a question mark.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            '2–6 short, mutually exclusive choices shown as buttons.',
        },
        allow_free_text: {
          type: 'boolean',
          default: true,
          description:
            'When true (default), the user can type a custom answer instead of picking an option.',
        },
      },
    }),
    execute: async (input: unknown) => executeAskUser(input),
  });
}

function listSubagentsTool() {
  return tool({
    description:
      'List every subagent spawned this session (running, completed, ' +
      'failed, or cancelled). Use when you need to recover a task_id you ' +
      'forgot, check on background tasks the user is asking about, or ' +
      'sweep for anything still running. Records are in-memory and do not ' +
      'survive an app restart.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['running', 'completed', 'failed', 'cancelled'],
          description:
            'Optional filter. Omit to list everything.',
        },
      },
    }),
    execute: async (input: unknown) => executeListSubagents(input),
  });
}

async function executeTaskTool(
  input: unknown,
): Promise<string | { error: string }> {
  const parsed = parseTaskInput(input);
  if ('error' in parsed) return parsed;
  const { description, prompt, background } = parsed;

  const settings = useSettingsStore.getState();
  const active = settings.modelConfigs.find(
    (m) => m.id === settings.activeModelId,
  );
  if (!active) {
    return { error: 'task: no active model configured' };
  }
  const modelConfig = settings.resolveModelConfig(active);

  const tools = await loadSubagentTools();
  const system = buildSubagentSystem(description);

  const { id, done } = spawnSubagent({
    description,
    prompt,
    background,
    tools,
    modelConfig,
    system,
  });

  if (background) {
    return (
      `Spawned subagent \`${id}\` in background (${description}). ` +
      `Call read_subagent_output with task_id "${id}" to check on it.`
    );
  }

  const result = await done;
  if (result === null) {
    const snap = snapshotSubagent(id);
    const reason = snap?.error ?? snap?.status ?? 'unknown';
    return { error: `Subagent \`${id}\` finished without a report (${reason})` };
  }
  return result;
}

function parseTaskInput(
  input: unknown,
):
  | { description: string; prompt: string; background: boolean }
  | { error: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'task: expected { description, prompt, background? }' };
  }
  const r = input as Record<string, unknown>;
  if (typeof r.description !== 'string' || !r.description.trim()) {
    return { error: 'task: description must be a non-empty string' };
  }
  if (typeof r.prompt !== 'string' || !r.prompt.trim()) {
    return { error: 'task: prompt must be a non-empty string' };
  }
  const background = r.background === true;
  return {
    description: r.description.trim(),
    prompt: r.prompt,
    background,
  };
}

function buildSubagentSystem(description: string): string {
  return [
    `You are a read-only investigative subagent spawned to handle: ${description}.`,
    'You do NOT see the parent conversation — operate only on the prompt the parent gave you.',
    'Available tools: read_file / glob / grep / MCP / Skills / web search. You CANNOT write files, edit files, run shell commands, or spawn other subagents.',
    "Stay focused. Keep the report concise — the parent will quote or summarize it, so don't dump raw file contents unless they're strictly necessary.",
    'Budget: up to 10 tool-call rounds. Finish with a short summary (findings + any pointers the parent should follow up on).',
  ].join('\n\n');
}

async function executeReadSubagentOutput(
  input: unknown,
): Promise<string | { error: string }> {
  const id = extractTaskId(input);
  if ('error' in id) return id;
  const includeTrace =
    input && typeof input === 'object' && input !== null
      ? Boolean((input as { include_trace?: unknown }).include_trace)
      : false;
  const snap = snapshotSubagent(id.task_id);
  if (!snap) return { error: `unknown task_id \`${id.task_id}\`` };
  return formatSnapshot(snap, { includeTrace });
}

async function executeStopSubagent(
  input: unknown,
): Promise<string | { error: string }> {
  const id = extractTaskId(input);
  if ('error' in id) return id;
  const ok = stopSubagent(id.task_id);
  if (!ok) {
    const snap = snapshotSubagent(id.task_id);
    if (!snap) return { error: `unknown task_id \`${id.task_id}\`` };
    return `Subagent \`${id.task_id}\` is not running (status: ${snap.status}).`;
  }
  return `Requested cancellation of subagent \`${id.task_id}\`.`;
}

async function executeAskUser(
  input: unknown,
): Promise<string | { error: string }> {
  if (!input || typeof input !== 'object') {
    return { error: 'ask_user: expected an object input' };
  }
  const r = input as Record<string, unknown>;
  const question = typeof r.question === 'string' ? r.question.trim() : '';
  if (!question) {
    return { error: 'ask_user: `question` must be a non-empty string' };
  }
  const options = Array.isArray(r.options)
    ? r.options
        .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
        .map((o) => o.trim())
    : [];
  if (options.length === 0) {
    return { error: 'ask_user: `options` must contain at least one string' };
  }
  const allowFreeText =
    typeof r.allow_free_text === 'boolean' ? r.allow_free_text : true;

  const answer = await requestAskUser({
    question,
    options,
    allowFreeText,
  });
  const trimmed = answer.trim();
  if (!trimmed) {
    return { error: 'ask_user: user dismissed the prompt without answering' };
  }
  return `User answered: ${trimmed}`;
}

async function executeListSubagents(
  input: unknown,
): Promise<string | { error: string }> {
  const filter =
    input && typeof input === 'object'
      ? (input as { status?: unknown }).status
      : undefined;
  const allowed = new Set(['running', 'completed', 'failed', 'cancelled']);
  if (typeof filter === 'string' && !allowed.has(filter)) {
    return { error: `invalid status filter \`${filter}\`` };
  }

  const all = listSubagents();
  const snaps =
    typeof filter === 'string' ? all.filter((s) => s.status === filter) : all;

  if (snaps.length === 0) {
    return typeof filter === 'string'
      ? `No subagents in status \`${filter}\`.`
      : 'No subagents spawned this session.';
  }

  const lines = snaps.map((s) => {
    const duration = s.endedAt
      ? `${((s.endedAt - s.startedAt) / 1000).toFixed(1)}s`
      : `${((Date.now() - s.startedAt) / 1000).toFixed(1)}s running`;
    return `- \`${s.id}\` · ${s.status} · ${duration} · ${s.description}`;
  });
  return `Subagents (${snaps.length}):\n${lines.join('\n')}`;
}

function extractTaskId(
  input: unknown,
): { task_id: string } | { error: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'expected { task_id: string }' };
  }
  const r = input as Record<string, unknown>;
  if (typeof r.task_id !== 'string' || !r.task_id.trim()) {
    return { error: 'task_id must be a non-empty string' };
  }
  return { task_id: r.task_id.trim() };
}

function formatSnapshot(
  snap: SubagentSnapshot,
  opts: { includeTrace?: boolean } = {},
): string {
  const lines: string[] = [
    `Subagent \`${snap.id}\` — ${snap.description}`,
    `Status: ${snap.status}${snap.error ? ` (${snap.error})` : ''}`,
  ];
  if (snap.endedAt) {
    lines.push(`Duration: ${((snap.endedAt - snap.startedAt) / 1000).toFixed(1)}s`);
  }
  lines.push('');
  lines.push(snap.output || '(no output yet)');

  if (opts.includeTrace && snap.events.length > 0) {
    lines.push('');
    lines.push(`--- Audit trace (${snap.events.length} events) ---`);
    for (const ev of snap.events) {
      if (ev.kind === 'reasoning') {
        lines.push(`[thought] ${truncateInline(ev.text, 240)}`);
      } else if (ev.kind === 'text') {
        lines.push(`[text]    ${truncateInline(ev.text, 240)}`);
      } else if (ev.kind === 'tool-call') {
        lines.push(
          `[call]    ${ev.toolName}(${truncateInline(tryStringify(ev.input), 240)})`,
        );
      } else {
        const tag = ev.isError ? '[error]' : '[result]';
        lines.push(
          `${tag}  ${ev.toolName}: ${truncateInline(ev.output, 240)}`,
        );
      }
    }
  }

  return lines.join('\n');
}

function truncateInline(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max) + `… (+${flat.length - max} chars)`;
}

function tryStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Full tool-call pipeline: permission check → approval prompt (if needed) →
 * actual Rust invocation. Returns a shaped error object on denial so the
 * AI SDK surfaces it as `tool-error` without aborting the step.
 */
async function executeToolCall(
  name: string,
  input: unknown,
): Promise<string | { error: string }> {
  // Runtime mode gate: plan-mode-blocked tools error out when called
  // while the conversation is still in plan mode. Read at call time so a
  // mid-turn `exit_plan_mode` takes effect on the very next tool call.
  if (PLAN_MODE_BLOCKLIST.has(name)) {
    const currentMode = currentConversationMode();
    if (currentMode === 'plan') {
      return {
        error:
          `${name} is not available in plan mode. Finish planning (use ` +
          `todo_write / read_file / grep), then call exit_plan_mode to ` +
          `request execution. Do not retry this call until the mode has ` +
          `flipped.`,
      };
    }
  }

  if (isGatedTool(name)) {
    const gate = await runApprovalGate(name, input);
    if (gate.kind === 'deny') return { error: gate.reason };
    // fall through on allow
  }

  // Phase E · preToolUse hooks. A `block`-mode hook that exits non-zero
  // cancels the tool call entirely. `warn` / `ignore` outcomes are logged
  // but don't stop anything.
  const preBlocked = await dispatchHooks('preToolUse', name, input);
  if (preBlocked) return { error: preBlocked };

  const result = await invoke<ToolInvocationResult>('invoke_tool', {
    name,
    input,
  });

  // Fire-and-capture postToolUse. Block mode is meaningless after the fact
  // (the tool already ran) — outcomes are only surfaced as warnings.
  await dispatchHooks('postToolUse', name, input, {
    output: result.content,
    isError: result.isError,
  });

  if (result.isError) return { error: result.content };
  return result.content;
}

interface HookOutcome {
  matcher: string;
  failMode: string;
  exitCode: number | null;
  success: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  blocked: boolean;
}

/**
 * Runs all hooks matching `(event, toolName)`. Returns a non-null string
 * when a `block`-mode hook failed — caller uses that to abort the call.
 */
async function dispatchHooks(
  event: 'preToolUse' | 'postToolUse',
  toolName: string,
  input: unknown,
  output?: unknown,
): Promise<string | null> {
  let outcomes: HookOutcome[];
  try {
    outcomes = await invoke<HookOutcome[]>('run_hooks', {
      event,
      toolName,
      input,
      output: output ?? null,
    });
  } catch (err) {
    // Hook failure never silently blocks the tool by default — if the
    // entire run_hooks command fell over, log and continue.
    console.warn(`run_hooks(${event}) failed`, err);
    return null;
  }
  for (const o of outcomes) {
    if (!o.success) {
      console.warn(
        `[hook ${event} matcher=${o.matcher}] exit=${o.exitCode ?? '?'} ${
          o.timedOut ? '(timed out)' : ''
        }\nstderr: ${o.stderr.trim()}`,
      );
    }
    if (o.blocked) {
      return (
        `Blocked by ${event} hook (matcher: ${o.matcher}` +
        `${o.exitCode != null ? `, exit ${o.exitCode}` : ''})` +
        (o.stderr.trim() ? `\n${o.stderr.trim()}` : '')
      );
    }
  }
  return null;
}

type GateOutcome =
  | { kind: 'allow'; source: 'session' | 'persisted' | 'user' }
  | { kind: 'deny'; reason: string };

async function runApprovalGate(
  name: string,
  input: unknown,
): Promise<GateOutcome> {
  const store = usePermissionsStore.getState();
  const activeConversationId = useChatStore.getState().currentConversationId;

  // Cheapest check first: session allows live entirely in memory. The
  // conversation id is required so mode-execute allows don't leak across
  // conversations (they were added for one specific conversation's
  // execute session).
  if (store.matchSession(name, input, activeConversationId)) {
    return { kind: 'allow', source: 'session' };
  }

  let check: PermissionCheckResult;
  try {
    check = await invoke<PermissionCheckResult>('check_permission', {
      toolName: name,
      input,
    });
  } catch (err) {
    // If the check command itself fails, fail closed but say why.
    return { kind: 'deny', reason: `permission check failed: ${String(err)}` };
  }

  if (check.decision === 'allow') {
    return { kind: 'allow', source: 'persisted' };
  }
  if (check.decision === 'deny') {
    const pattern = check.matchedRule?.pattern ?? '';
    const suffix = pattern
      ? ` (rule: ${check.matchedRule?.toolName ?? name} ${pattern})`
      : '';
    return {
      kind: 'deny',
      reason: `Blocked by policy${suffix}${check.reason ? ` — ${check.reason}` : ''}`,
    };
  }

  // decision === 'ask'
  const saveAsPattern = defaultPatternFor(name, input);
  const answer = await requestApproval({
    tool: name,
    input,
    reason: check.reason ?? undefined,
    saveAsPattern,
  });

  if (answer.kind === 'deny') {
    return { kind: 'deny', reason: 'User denied this tool call' };
  }
  if (answer.kind === 'instruct') {
    // User chose "don't do this, here's what to do instead". Return the
    // instruction as a tool-error so the model reads it and adapts on
    // the next step in the same turn.
    const instruction = answer.instruction.trim();
    return {
      kind: 'deny',
      reason: instruction
        ? `User declined this call and asks you to instead: ${instruction}`
        : 'User declined this tool call',
    };
  }
  if (answer.kind === 'session') {
    usePermissionsStore
      .getState()
      .addSessionAllow(name, saveAsPattern);
  }
  if (answer.kind === 'always') {
    try {
      await usePermissionsStore.getState().savePermission({
        toolName: name,
        pattern: saveAsPattern,
        decision: 'allow',
      });
    } catch (err) {
      console.warn('save_permission failed — continuing with one-shot allow', err);
    }
  }
  return { kind: 'allow', source: 'user' };
}

/**
 * Some MCP servers emit minimal schemas (`{}` or schemas without a `type`).
 * AI SDK / zod-style validators tolerate most shapes, but Gemini's tool
 * adapter is picky — it wants a plain object schema. Force `type: "object"`
 * when the schema looks object-y but lacks the declaration.
 */
function sanitizeSchema(schema: unknown): any {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const s: any = { ...(schema as Record<string, unknown>) };
  if (!('type' in s) && !('anyOf' in s) && !('oneOf' in s) && !('$ref' in s)) {
    s.type = 'object';
  }
  if (s.type === 'object' && !s.properties) {
    s.properties = {};
  }
  return s;
}
