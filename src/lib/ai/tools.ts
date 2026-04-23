import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { toast } from 'sonner';
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
import { useBrandStore } from '@/store/brandStore';
import {
  spawnSubagent,
  snapshotSubagent,
  stopSubagent,
  listSubagents,
  type SubagentSnapshot,
} from '@/lib/ai/subagent';
import { requestAskUser } from '@/lib/ai/ask-user-broker';
import { formatTaxonomy } from '@/lib/ai/brand-taxonomy';

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
  // Regular subagents get read-only wiki access; write / rebuild /
  // delete belong to the main agent and the dedicated wiki-ingest
  // subagent (loaded via loadWikiIngestTools).
  'write_wiki_page',
  'update_wiki_index',
  'delete_wiki_page',
  // Only the main agent opens folders for the user or inspects the raw
  // inbox — subagents are isolated investigators, not UX helpers.
  'open_agora_folder',
  'list_raw_files',
  // Auto-memory curation is the user's conversation with the main
  // agent — subagents don't get to look at or touch it.
  'list_auto_memories',
  'delete_auto_memory',
  // Dreaming is a main-conversation workflow. Subagents don't run
  // dreaming or curate its output.
  'run_dreaming',
  // Brand Layer writes are user-identity edits — subagents never touch
  // them. Reads stay available so an investigation can reference the
  // user's preferences without triggering a write path.
  'append_brand_file',
  'replace_brand_file',
  'delete_brand_line',
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

  // Brand Layer · the five Markdown files that shape the agent's
  // identity. Reads auto-approve; writes go through the same approval
  // gate as built-in write_file but under distinct tool names so the
  // user can manage allow/deny rules separately in Settings →
  // Permissions.
  set['list_brand_files'] = listBrandFilesTool();
  set['read_brand_file'] = readBrandFileTool();
  set['append_brand_file'] = appendBrandFileTool();
  set['replace_brand_file'] = replaceBrandFileTool();
  set['delete_brand_line'] = deleteBrandLineTool();

  // Wiki Layer · the main agent gets full CRUD so the user can
  // maintain knowledge pages through conversation ("summarize this
  // article into a wiki page", "delete that stale page on X"). Reads
  // are also in subagents, but writes are blocked there via
  // SUBAGENT_BLOCKLIST. No approval gate — same reasoning as the Brand
  // Layer: reversible, ergonomics > friction, the real defenses are
  // filename whitelist + frontmatter-validated content.
  set['list_wiki_pages'] = listWikiPagesTool();
  set['read_wiki_page'] = readWikiPageTool();
  set['write_wiki_page'] = writeWikiPageTool();
  set['update_wiki_index'] = updateWikiIndexTool();
  set['delete_wiki_page'] = deleteWikiPageTool();

  // Raw Layer · the user-facing tab was removed — users drop files into
  // ~/.agora/raw/ from Finder, the watcher auto-generates a Wiki page.
  // The agent still needs a way to answer "what's in my raw folder?"
  // and to open filesystem folders for the user.
  set['list_raw_files'] = listRawFilesTool();
  set['open_agora_folder'] = openAgoraFolderTool();

  // Auto Memory · the vector store the post-turn extractor populates.
  // The Settings UI for browsing / deleting these entries was removed;
  // the main agent now handles those workflows conversationally.
  set['list_auto_memories'] = listAutoMemoriesTool();
  set['delete_auto_memory'] = deleteAutoMemoryTool();

  // Dreaming · run the nightly distillation, which auto-appends
  // candidates to the right Brand files. Review/undo happens in
  // Settings → Personalization, not through a tool.
  set['run_dreaming'] = runDreamingTool();

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
      execute: (input: unknown) =>
        executeToolCall(spec.name, input, { forSubagent: true }),
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
 * Brand Layer synth tools.
 *
 * Five Markdown files under `~/.agora/config/` shape the agent's identity:
 * SOUL, USER, TOOLS, MEMORY (user-editable), and AGENTS (system-owned,
 * read-only). The user maintains these entirely through chat — there is
 * no Settings UI for them. That's deliberate: the agent is the natural
 * editor for its own identity.
 *
 * Approval model — deliberately **not** gated:
 *   - Reads (`list_brand_files`, `read_brand_file`) are trivially safe.
 *   - Writes (`append_brand_file`, `replace_brand_file`,
 *     `delete_brand_line`) run without an approval prompt. Gating every
 *     "remember X" would kill the ergonomics, and the writes are
 *     essentially reversible: a bad append becomes a `delete_brand_line`,
 *     a bad replace becomes another replace. The real defenses sit
 *     lower:
 *       * Rust-layer secret denylist (`memory_active.rs`) refuses
 *         writes that look like API keys, tokens, or hex-blob secrets.
 *       * Filename whitelist — only the five known Brand filenames are
 *         accepted; no path injection surface.
 *       * AGENTS.md refuses every write at the Rust layer.
 *       * Every write surfaces a toast so it is never silent.
 */

const BRAND_FILE_NAMES = ['SOUL.md', 'USER.md', 'TOOLS.md', 'MEMORY.md', 'AGENTS.md'] as const;
const WRITABLE_BRAND_FILES = ['SOUL.md', 'USER.md', 'TOOLS.md', 'MEMORY.md'] as const;

type BrandFileName = (typeof BRAND_FILE_NAMES)[number];
type WritableBrandFile = (typeof WRITABLE_BRAND_FILES)[number];

function listBrandFilesTool() {
  return tool({
    description:
      "List the user's Brand Layer files and summarize each one (path, " +
      'size, whether it has content, whether it is user-editable). These ' +
      'five Markdown files shape the assistant\'s identity:\n' +
      '- SOUL.md: personality / communication style (editable)\n' +
      '- USER.md: who the user is — name, role, timezone (editable)\n' +
      '- TOOLS.md: tech stack / tooling preferences (editable)\n' +
      '- MEMORY.md: durable active memory (editable)\n' +
      '- AGENTS.md: system safety rules (read-only)\n' +
      'Call this first when the user asks to view or edit any of them.',
    inputSchema: jsonSchema({ type: 'object', properties: {} }),
    execute: async () => executeListBrandFiles(),
  });
}

async function executeListBrandFiles(): Promise<string | { error: string }> {
  try {
    const payload = await invoke<import('@/types').BrandPayload>('read_brand');
    const rows = BRAND_FILE_NAMES.map((name) => {
      const section = readSection(payload, name);
      return {
        file: name,
        path: section.path,
        bytes: section.content.length,
        empty: section.content.length === 0,
        editable: name !== 'AGENTS.md',
        truncated: section.truncated,
      };
    });
    return JSON.stringify(
      { configDir: payload.configDir, files: rows },
      null,
      2,
    );
  } catch (err) {
    return { error: `list_brand_files failed: ${String(err)}` };
  }
}

function readBrandFileTool() {
  return tool({
    description:
      "Read one of the user's Brand Layer Markdown files. Use this " +
      'whenever the user asks to see their current SOUL / USER / TOOLS / ' +
      'MEMORY / AGENTS content, or before proposing an edit (so you can ' +
      'diff mentally against what\'s already there). Returns the raw ' +
      'Markdown verbatim.',
    inputSchema: jsonSchema({
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          enum: [...BRAND_FILE_NAMES],
          description: 'Which Brand file to read.',
        },
      },
    }),
    execute: async (input: unknown) => executeReadBrandFile(input),
  });
}

async function executeReadBrandFile(
  input: unknown,
): Promise<string | { error: string }> {
  const file = extractBrandFile(input);
  if ('error' in file) return file;
  try {
    const section = await invoke<import('@/types').BrandSection>(
      'read_brand_file',
      { file: file.name },
    );
    if (!section.content) {
      return `(${file.name} is empty)`;
    }
    const header = `# ${file.name}  (${section.path ?? 'unsaved'})`;
    return `${header}\n\n${section.content}`;
  } catch (err) {
    return { error: `read_brand_file failed: ${String(err)}` };
  }
}

function appendBrandFileTool() {
  return tool({
    description:
      'Append a durable line to a writable Brand file (SOUL / USER / ' +
      'TOOLS / MEMORY). Use this when the user asks you to remember ' +
      'something, or when you have high confidence that a fact from the ' +
      'current turn should persist across future conversations. Pick ' +
      '`file`:\n' +
      formatTaxonomy({ suffix: '.md' }) +
      '\n' +
      'Write one compact line; exact duplicates are silently deduplicated. ' +
      'Do NOT persist secrets (API keys, passwords, tokens) — the writer ' +
      'refuses and returns a reason. AGENTS.md is not writable through ' +
      'this tool.',
    inputSchema: jsonSchema({
      type: 'object',
      required: ['file', 'content'],
      properties: {
        file: {
          type: 'string',
          enum: [...WRITABLE_BRAND_FILES],
          description: 'Which writable Brand file to append to.',
        },
        content: {
          type: 'string',
          description:
            'Single-line memory to persist. Keep it short, factual, agent-useful. ' +
            'Prefer third-person phrasing ("User prefers X") over first-person.',
        },
        section: {
          type: 'string',
          description:
            'Optional `## Heading` to group related entries under. ' +
            'Re-using the same heading across calls lands subsequent entries in the same section.',
        },
      },
    }),
    execute: async (input: unknown) => executeAppendBrandFile(input),
  });
}

async function executeAppendBrandFile(
  input: unknown,
): Promise<string | { error: string }> {
  const parsed = extractWritableBrand(input);
  if ('error' in parsed) return parsed;
  const { name, rest } = parsed;
  const content = typeof rest.content === 'string' ? rest.content.trim() : '';
  const section =
    typeof rest.section === 'string' && rest.section.trim()
      ? rest.section.trim()
      : undefined;
  if (!content) {
    return { error: 'append_brand_file: content is required and must be non-empty' };
  }

  try {
    const result = await invoke<{
      written: boolean;
      file: string;
      reason?: string | null;
    }>('append_to_memory', { file: name, content, section });

    if (!result.written) {
      const why = result.reason ?? 'skipped';
      toast.warning(`Not remembered: ${why}`);
      return `Write skipped: ${why}`;
    }

    void useBrandStore.getState().refresh();
    const display = content.length > 60 ? content.slice(0, 57) + '…' : content;
    toast.success(`Appended to ${name}: ${display}`);
    return `Appended to ${name}: "${content}"${section ? ` (under "${section}")` : ''}.`;
  } catch (err) {
    return { error: `append_brand_file failed: ${String(err)}` };
  }
}

function replaceBrandFileTool() {
  return tool({
    description:
      'Overwrite a writable Brand file (SOUL / USER / TOOLS / MEMORY) ' +
      'with fresh content. Use this for deliberate restructures — when ' +
      'appending a bullet would not cut it, or the user asked you to ' +
      'rewrite the whole file. Pass the COMPLETE new Markdown body; the ' +
      'previous contents are discarded. ALWAYS read the current file ' +
      'first (via `read_brand_file`) so you do not accidentally drop ' +
      'existing content. AGENTS.md is read-only and cannot be overwritten.',
    inputSchema: jsonSchema({
      type: 'object',
      required: ['file', 'content'],
      properties: {
        file: {
          type: 'string',
          enum: [...WRITABLE_BRAND_FILES],
          description: 'Which writable Brand file to overwrite.',
        },
        content: {
          type: 'string',
          description:
            'Full replacement Markdown body. Line endings are preserved as-is.',
        },
      },
    }),
    execute: async (input: unknown) => executeReplaceBrandFile(input),
  });
}

async function executeReplaceBrandFile(
  input: unknown,
): Promise<string | { error: string }> {
  const parsed = extractWritableBrand(input);
  if ('error' in parsed) return parsed;
  const { name, rest } = parsed;
  if (typeof rest.content !== 'string') {
    return { error: 'replace_brand_file: content is required (string)' };
  }
  const content = rest.content;

  try {
    await invoke('write_brand_file', { file: name, content });
    void useBrandStore.getState().refresh();
    toast.success(`Replaced ${name} (${content.length} chars)`);
    return `Replaced ${name} with ${content.length} characters.`;
  } catch (err) {
    return { error: `replace_brand_file failed: ${String(err)}` };
  }
}

function deleteBrandLineTool() {
  return tool({
    description:
      'Delete a single exact line from a writable Brand file (SOUL / ' +
      'USER / TOOLS / MEMORY). Match is whitespace-trimmed but otherwise ' +
      'exact — pass the line verbatim as it appears in the file. Returns ' +
      'an error when the line is not found. AGENTS.md lines cannot be ' +
      'removed this way.',
    inputSchema: jsonSchema({
      type: 'object',
      required: ['file', 'line'],
      properties: {
        file: {
          type: 'string',
          enum: [...WRITABLE_BRAND_FILES],
        },
        line: {
          type: 'string',
          description:
            'The exact line to remove, whitespace-trimmed (e.g. "- User prefers pnpm").',
        },
      },
    }),
    execute: async (input: unknown) => executeDeleteBrandLine(input),
  });
}

async function executeDeleteBrandLine(
  input: unknown,
): Promise<string | { error: string }> {
  const parsed = extractWritableBrand(input);
  if ('error' in parsed) return parsed;
  const { name, rest } = parsed;
  const line = typeof rest.line === 'string' ? rest.line : '';
  if (!line.trim()) {
    return { error: 'delete_brand_line: `line` is required and must be non-empty' };
  }

  try {
    const removed = await invoke<boolean>('delete_memory_line', { file: name, line });
    if (!removed) {
      return `No line matching "${line.slice(0, 80)}" found in ${name}.`;
    }
    void useBrandStore.getState().refresh();
    toast.success(`Removed a line from ${name}`);
    return `Removed line from ${name}.`;
  } catch (err) {
    return { error: `delete_brand_line failed: ${String(err)}` };
  }
}

function extractBrandFile(
  input: unknown,
): { name: BrandFileName } | { error: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'expected { file: "SOUL.md"|"USER.md"|… }' };
  }
  const r = input as Record<string, unknown>;
  const raw = typeof r.file === 'string' ? r.file.trim() : '';
  // Tolerate both "MEMORY" and "MEMORY.md"; models are sometimes sloppy.
  const normalized = raw.endsWith('.md') ? raw : `${raw}.md`;
  if (!(BRAND_FILE_NAMES as readonly string[]).includes(normalized)) {
    return {
      error: `file must be one of ${BRAND_FILE_NAMES.join(', ')} (got "${raw}")`,
    };
  }
  return { name: normalized as BrandFileName };
}

function extractWritableBrand(
  input: unknown,
): { name: WritableBrandFile; rest: Record<string, unknown> } | { error: string } {
  const got = extractBrandFile(input);
  if ('error' in got) return got;
  if (!(WRITABLE_BRAND_FILES as readonly string[]).includes(got.name)) {
    return {
      error: `${got.name} is not writable — AGENTS.md is system-managed and read-only`,
    };
  }
  return {
    name: got.name as WritableBrandFile,
    rest: input as Record<string, unknown>,
  };
}

function readSection(
  payload: import('@/types').BrandPayload,
  name: BrandFileName,
): import('@/types').BrandSection {
  switch (name) {
    case 'SOUL.md':
      return payload.soul;
    case 'USER.md':
      return payload.user;
    case 'TOOLS.md':
      return payload.tools;
    case 'MEMORY.md':
      return payload.memory;
    case 'AGENTS.md':
      return payload.agents;
  }
}

/**
 * Wiki Layer — thin wrappers over Rust commands. Read-only variants are
 * handed to every agent; write / index variants are only in the wiki-
 * ingest subagent's toolset (see `loadWikiIngestTools`).
 */
function listWikiPagesTool() {
  return tool({
    description:
      "List every Wiki page currently in ~/.agora/wiki/. Use this BEFORE " +
      "writing a new Wiki entry so you can see whether an existing page " +
      "can be extended instead of creating a duplicate. Returns title, " +
      "tags, category, summary, and rel_path for each page.",
    inputSchema: jsonSchema({ type: 'object', properties: {} }),
    execute: async () => {
      try {
        const pages = await invoke<import('@/types').WikiPage[]>('list_wiki_pages');
        if (pages.length === 0) return 'No wiki pages yet.';
        return JSON.stringify(pages, null, 2);
      } catch (err) {
        return { error: `list_wiki_pages failed: ${String(err)}` };
      }
    },
  });
}

function readWikiPageTool() {
  return tool({
    description:
      "Read the full Markdown content (including frontmatter) of a Wiki " +
      "page. `rel_path` comes from `list_wiki_pages` and uses forward " +
      "slashes (e.g. `concepts/constitutional-ai.md`). Use this when you " +
      "want to cite or extend an existing page.",
    inputSchema: jsonSchema({
      type: 'object',
      required: ['rel_path'],
      properties: {
        rel_path: {
          type: 'string',
          description: 'Wiki page path relative to the wiki root.',
        },
      },
    }),
    execute: async (input: unknown) => {
      const r = input as { rel_path?: string };
      if (!r.rel_path) return { error: 'read_wiki_page: rel_path is required' };
      try {
        const page = await invoke<import('@/types').WikiPageContents>(
          'read_wiki_page',
          { relPath: r.rel_path },
        );
        return page.content;
      } catch (err) {
        return { error: `read_wiki_page failed: ${String(err)}` };
      }
    },
  });
}

function writeWikiPageTool() {
  return tool({
    description:
      "Create or overwrite a Wiki page. `rel_path` should use forward " +
      "slashes and end in `.md`; pick a `{category}/{slug}.md` layout " +
      "where category is one of `concepts`, `projects`, or `domains`. " +
      "The content must include YAML frontmatter (title, tags, category, " +
      "summary, updated_at, sources). Call `update_wiki_index` afterwards " +
      "so the index reflects your new page.",
    inputSchema: jsonSchema({
      type: 'object',
      required: ['rel_path', 'content'],
      properties: {
        rel_path: { type: 'string' },
        content: { type: 'string' },
      },
    }),
    execute: async (input: unknown) => {
      const r = input as { rel_path?: string; content?: string };
      if (!r.rel_path || typeof r.content !== 'string') {
        return { error: 'write_wiki_page: rel_path and content required' };
      }
      try {
        const page = await invoke<import('@/types').WikiPage>('write_wiki_page', {
          relPath: r.rel_path,
          content: r.content,
        });
        return `Wrote ${page.relPath} (title: ${page.title}).`;
      } catch (err) {
        return { error: `write_wiki_page failed: ${String(err)}` };
      }
    },
  });
}

function updateWikiIndexTool() {
  return tool({
    description:
      "Rebuild `wiki/index.md` after creating or modifying Wiki pages. " +
      "Call once at the end of an ingest pass, not between every page. " +
      "Returns the new index body as confirmation.",
    inputSchema: jsonSchema({ type: 'object', properties: {} }),
    execute: async () => {
      try {
        const body = await invoke<string>('update_wiki_index');
        const preview = body.length > 400 ? body.slice(0, 400) + '…' : body;
        return `Index rebuilt.\n\n${preview}`;
      } catch (err) {
        return { error: `update_wiki_index failed: ${String(err)}` };
      }
    },
  });
}

function deleteWikiPageTool() {
  return tool({
    description:
      "Delete a Wiki page by its `rel_path`. Use when the user explicitly " +
      'asks to remove a page, or when a page has become redundant after a ' +
      'merge. `rel_path` comes from `list_wiki_pages` (forward slashes, ' +
      'e.g. `concepts/foo.md`). After deleting, consider calling ' +
      '`update_wiki_index` so the index stops pointing at a missing file.',
    inputSchema: jsonSchema({
      type: 'object',
      required: ['rel_path'],
      properties: {
        rel_path: {
          type: 'string',
          description: 'Wiki page path relative to the wiki root.',
        },
      },
    }),
    execute: async (input: unknown) => {
      const r = input as { rel_path?: string };
      if (!r.rel_path) return { error: 'delete_wiki_page: rel_path is required' };
      try {
        const removed = await invoke<boolean>('delete_wiki_page', {
          relPath: r.rel_path,
        });
        return removed
          ? `Deleted ${r.rel_path}. Run \`update_wiki_index\` to refresh the index.`
          : `${r.rel_path} did not exist.`;
      } catch (err) {
        return { error: `delete_wiki_page failed: ${String(err)}` };
      }
    },
  });
}

/**
 * Raw inbox listing — replaces what the removed Raw Settings tab used
 * to show. When the user asks "what's queued in my raw folder?" or "did
 * my PDF get picked up?", the agent calls this to answer factually.
 */
function listRawFilesTool() {
  return tool({
    description:
      "List every file currently sitting in ~/.agora/raw/. Returns " +
      'path, size, last-modified time, and whether the format is ' +
      'supported by the ingest pipeline (md, markdown, txt, pdf, html, ' +
      'htm). Unsupported files are listed but will be skipped by the ' +
      'watcher. Use this when the user asks what files they have ' +
      'queued, or to diagnose why an ingest did not happen.',
    inputSchema: jsonSchema({ type: 'object', properties: {} }),
    execute: async () => {
      try {
        const files = await invoke<
          Array<{
            relPath: string;
            absPath: string;
            sizeBytes: number;
            modifiedAt: number;
            supported: boolean;
          }>
        >('list_raw_files');
        if (files.length === 0) {
          return 'Raw inbox is empty. Drop a Markdown / PDF / HTML / text file into ~/.agora/raw/ to trigger ingest.';
        }
        return JSON.stringify(files, null, 2);
      } catch (err) {
        return { error: `list_raw_files failed: ${String(err)}` };
      }
    },
  });
}

/**
 * Reveal one of the Agora subdirectories in the user's file manager.
 * Agora stores everything under ~/.agora/; the agent can hand the user
 * a Finder / Explorer window at the right spot without them having to
 * remember the path.
 */
function openAgoraFolderTool() {
  const allowed = ['', 'config', 'wiki', 'raw', 'logs', 'skills', 'workspace'];
  return tool({
    description:
      'Open one of the Agora subdirectories in the user\'s file ' +
      "manager (Finder / Explorer / Files). Use this when the user " +
      "wants to inspect files on disk — e.g. to drop a document into " +
      "`raw`, or view the generated pages in `wiki`. Pass `subdir` as " +
      "one of: '' (the agora root), 'config', 'wiki', 'raw', 'logs', " +
      "'skills', 'workspace'.",
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        subdir: {
          type: 'string',
          enum: allowed,
          description:
            "Which Agora subdirectory to open. Empty string opens the agora root.",
        },
      },
    }),
    execute: async (input: unknown) => {
      const r = (input ?? {}) as { subdir?: string };
      const subdir = typeof r.subdir === 'string' ? r.subdir.trim() : '';
      if (!allowed.includes(subdir)) {
        return {
          error: `subdir must be one of ${JSON.stringify(allowed)}`,
        };
      }
      try {
        const path = await invoke<string>('resolve_agora_path', { subdir });
        await openPath(path);
        toast.success(`Opened ${path}`);
        const label = subdir === '' ? 'agora root' : subdir;
        return `Opened ${label} at ${path}.`;
      } catch (err) {
        return { error: `open_agora_folder failed: ${String(err)}` };
      }
    },
  });
}

/* ─── Auto Memory curation (user-conversation tools) ──────── */

interface AutoMemoryRow {
  id: string;
  text: string;
  kind: string;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  createdAt: number;
}

function listAutoMemoriesTool() {
  return tool({
    description:
      "List the user's automatically-extracted memories (the post-turn " +
      'extractor writes to this store — facts, preferences, events the ' +
      'model picked out from past conversations). Use when the user asks ' +
      'what you "remember automatically" or wants to audit / clean up the ' +
      'store. For their explicit memories (the ones they asked you to ' +
      'save), call `read_brand_file` with "MEMORY.md" instead.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          default: 50,
          description: 'Max rows to return (most-recent first).',
        },
      },
    }),
    execute: async (input: unknown) => {
      const r = (input ?? {}) as { limit?: number };
      const limit = typeof r.limit === 'number' && r.limit > 0 ? r.limit : 50;
      try {
        const rows = await invoke<AutoMemoryRow[]>('list_auto_memory', { limit });
        if (rows.length === 0) return 'No auto-extracted memories yet.';
        return JSON.stringify(rows, null, 2);
      } catch (err) {
        return { error: `list_auto_memories failed: ${String(err)}` };
      }
    },
  });
}

function deleteAutoMemoryTool() {
  return tool({
    description:
      'Delete a single auto-extracted memory by id. Ids come from ' +
      '`list_auto_memories`. Use when the user asks to forget something ' +
      'specific ("that wrong note about pnpm", "the entry from 2026-04-20"). ' +
      'The vector is gone afterwards; if the user regrets it, they can ' +
      're-teach by mentioning the fact again.',
    inputSchema: jsonSchema({
      type: 'object',
      required: ['id'],
      properties: {
        id: {
          type: 'string',
          description: 'The auto-memory id from list_auto_memories.',
        },
      },
    }),
    execute: async (input: unknown) => {
      const r = (input ?? {}) as { id?: string };
      if (!r.id) return { error: 'delete_auto_memory: id is required' };
      try {
        const removed = await invoke<boolean>('delete_auto_memory', { id: r.id });
        if (removed) {
          toast.success('Forgot that auto memory');
          return `Deleted auto memory ${r.id}.`;
        }
        return `No auto memory with id ${r.id}.`;
      } catch (err) {
        return { error: `delete_auto_memory failed: ${String(err)}` };
      }
    },
  });
}

/* ─── Dreaming (user-conversation tools) ──────────────────── */

function runDreamingTool() {
  return tool({
    description:
      'Trigger a Dreaming pass — read conversation log entries, ask the ' +
      'model to distill durable memories, and append each to the right ' +
      'Brand file (USER/TOOLS/SOUL/MEMORY) automatically. Defaults to ' +
      'everything since the last Dreaming run (or the last 24h if it has ' +
      "never run). Returns a summary of how many landed; the user " +
      'reviews and prunes in Settings → Personalization if anything ' +
      'looks off.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description:
            'Optional target date in YYYY-MM-DD to reprocess that single day. Omit for the default "since last run" behaviour.',
        },
      },
    }),
    execute: async (input: unknown) => {
      const r = (input ?? {}) as { date?: string };
      try {
        const { runDreaming } = await import('@/lib/ai/dreaming');
        const dream = await runDreaming(r.date?.trim() || undefined);
        if (!dream) {
          return r.date
            ? `No conversation log for ${r.date} — nothing to distill.`
            : 'No new conversation content since the last Dreaming run — nothing to distill.';
        }
        return JSON.stringify(
          {
            date: dream.date,
            applied: dream.applied,
            skipped: dream.skipped,
            candidates: dream.candidates,
          },
          null,
          2,
        );
      } catch (err) {
        return { error: `run_dreaming failed: ${String(err)}` };
      }
    },
  });
}

/**
 * Toolset handed to the wiki-ingest subagent (Phase 4). Deliberately
 * narrow: just enough to read a raw file, understand existing pages,
 * and write its output. The subagent has no shell, no parent-memory,
 * no further task delegation.
 */
export async function loadWikiIngestTools(): Promise<ToolSet> {
  let specs: ToolSpecDto[] = [];
  try {
    specs = await invoke<ToolSpecDto[]>('list_frontend_tools');
  } catch (err) {
    console.warn('list_frontend_tools failed for wiki ingest', err);
    return {};
  }
  const allow = new Set(['read_file', 'glob', 'grep']);
  const set: ToolSet = {};
  for (const spec of specs) {
    if (!allow.has(spec.name)) continue;
    set[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(sanitizeSchema(spec.inputSchema)),
      execute: (input: unknown) =>
        executeToolCall(spec.name, input, { forSubagent: true }),
    });
  }
  set['list_wiki_pages'] = listWikiPagesTool();
  set['read_wiki_page'] = readWikiPageTool();
  set['write_wiki_page'] = writeWikiPageTool();
  set['update_wiki_index'] = updateWikiIndexTool();
  return set;
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
interface ExecuteToolCallOptions {
  /** When true, skip the user-interrupt injection path. Set by subagent
   *  toolsets so a mid-turn user message in the main conversation
   *  doesn't leak into a subagent's tool_result (the subagent has no
   *  business reacting to parent-UI chatter, and spending its step
   *  budget on it would starve the original task). */
  forSubagent?: boolean;
}

async function executeToolCall(
  name: string,
  input: unknown,
  opts: ExecuteToolCallOptions = {},
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

  // Mid-turn user-interrupt injection. If the user typed a message while
  // this stream was running, splice it in as a `<user-interrupt>` block
  // ahead of the tool result so the model sees it on the very next step
  // of the current turn — no manual send-button click needed. Messages with file
  // attachments stay queued (they can't ride a text-only tool_result).
  // Skipped for subagents: their context has nothing to do with the
  // user's main conversation, and pulling interrupts into their
  // tool_result would starve their step budget on out-of-scope prompts.
  const content = opts.forSubagent
    ? result.content
    : injectInterrupts(result.content);

  if (result.isError) return { error: content };
  return content;
}

function injectInterrupts(original: string): string {
  const store = useChatStore.getState();
  const conversationId = store.currentConversationId;
  if (!conversationId) return original;
  const drained = store.consumeQueueAsInterrupts(conversationId);
  if (drained.length === 0) return original;

  // Thread each drained message into the streaming assistant's parts
  // list so scroll-back shows a faithful trail of what the user said
  // and when, even though the interrupt wasn't a standalone turn.
  const active = store.activeStreams[conversationId];
  if (active?.assistantMessageId) {
    for (const m of drained) {
      store.appendInterruptPart(conversationId, active.assistantMessageId, {
        type: 'user_interrupt',
        text: m.content.trim(),
        at: m.createdAt,
      });
    }
  }

  const preface = drained
    .map(
      (m) =>
        `<user-interrupt at="${new Date(m.createdAt).toISOString()}">\n${m.content.trim()}\n</user-interrupt>`,
    )
    .join('\n');
  return `${preface}\n\n${original}`;
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
