export type Role = 'user' | 'assistant' | 'system';

export type Provider = 'openai' | 'anthropic' | 'gemini';

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; dataUrl: string; mimeType: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      input: unknown;
      /** Raw JSON accumulating while the model streams `input_json_delta`s. */
      inputPartial?: string;
    }
  | { type: 'tool_result'; call_id: string; content: string; is_error?: boolean }
  /** Marks the start of a new streamText step (one model-loop round trip).
   *  Used by the Plan renderer to group subsequent thinking / tool calls
   *  into per-step tasks. Emitted once per step, never persisted content. */
  | { type: 'step_start'; id: string };

export interface Message {
  id: string;
  conversationId: string;
  parentId: string | null;
  role: Role;
  content: string;
  createdAt: number;
  parts?: MessagePart[];
  /** Display name of the model that produced this assistant reply. */
  modelName?: string | null;
  /** Prompt tokens consumed by this turn (assistant messages only). */
  inputTokens?: number | null;
  /** Completion tokens produced by this turn. */
  outputTokens?: number | null;
  /** True if extended thinking was requested but the model/gateway didn't
   *  accept it — UI shows a small hint instead of silent nothingness. */
  thinkingSkipped?: boolean;
  /** 0-based position among siblings (same parent + same role). */
  siblingIndex: number;
  /** Total siblings including this one. `1` means no branches. */
  siblingCount: number;
  /** ID of the immediate previous sibling, or null at the left edge. */
  prevSiblingId?: string | null;
  /** ID of the immediate next sibling, or null at the right edge. */
  nextSiblingId?: string | null;
  /** Visual-only bubble (e.g., the text the user picked in an ask_user
   *  prompt). Rendered in the chat flow so the conversation reads
   *  naturally, but skipped by `toModelMessages` when reconstructing
   *  provider history — the real answer is already on the tool_result
   *  part of the preceding assistant message. Not persisted. */
  transient?: boolean;
}

/** Agent operating mode. Mirrors the Rust-side column on `conversations`.
 *  - `chat`    — normal behavior (all tools, approvals as configured)
 *  - `plan`    — readonly-only; writes + bash stripped from the toolset
 *  - `execute` — writes auto-allowed session-wide; bash still asks */
export type ConversationMode = 'chat' | 'plan' | 'execute';

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  modelId: string;
  pinned: boolean;
  /** True when user has manually renamed — auto-title won't overwrite. */
  titleLocked: boolean;
  mode: ConversationMode;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type AutoTitleMode = 'off' | 'first' | 'every';
export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

export interface GlobalSettings {
  apiKey: string;
  baseUrlOpenai: string;
  baseUrlAnthropic: string;
  baseUrlGemini: string;
  tavilyApiKey: string;
  webSearchEnabled: boolean;
  autoTitleMode: AutoTitleMode;
  thinkingEffort: ThinkingEffort;
  /** Absolute path the agent's built-in FS/Bash tools resolve relative paths
   *  against. Empty = no workspace set; relative paths error out. */
  workspaceRoot: string;
  /** Skip the approval prompt for read-only tools (`read_file`, `glob`,
   *  `grep`, `read_task_output`). Default true. */
  autoApproveReadonly: boolean;
  /** JSON blob for hook config. See `docs/TOOLS.md`. */
  hooksJson: string;
}

export interface SkillsMeta {
  directory: string;
  scriptsEnabled: boolean;
}

export interface ScriptUpload {
  filename: string;
  contentBase64: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  scripts: ScriptUpload[];
}

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  loginShell: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface Skill {
  name: string;
  description: string;
  path: string;
  allowedTools: string[];
  body: string;
}

/** A single persisted permission rule. `(toolName, pattern)` is the logical
 *  key — empty `pattern` means "apply to every invocation of this tool". */
export interface ToolPermission {
  id: string;
  toolName: string;
  pattern: string;
  decision: 'allow' | 'deny';
  createdAt: number;
}

/** Shape returned by Rust `check_permission`. `ask` means the frontend
 *  must prompt the user. */
export interface PermissionCheckResult {
  decision: 'allow' | 'deny' | 'ask';
  matchedRule?: ToolPermission | null;
  reason?: string | null;
}

/** A pending request flowing from a tool call into the approval UI. */
export interface ApprovalRequest {
  tool: string;
  input: unknown;
  reason?: string;
  /** Pattern we would save if the user picks "Always". Shown so they know
   *  what scope they're agreeing to. */
  saveAsPattern: string;
}

export type ApprovalAnswer =
  | { kind: 'once' }
  | { kind: 'session' }
  | { kind: 'always' }
  | { kind: 'deny' }
  /** "Deny and tell the AI what to do instead". `instruction` is forwarded
   *  to the model as the tool-error reason so it can adapt on the spot. */
  | { kind: 'instruct'; instruction: string };

/**
 * A pending clarification request raised by the `ask_user` tool. Carries the
 * question the model wants answered plus the click-through options it
 * suggested. `allowFreeText` gates the free-text fallback on the UI — when
 * false, the user must pick one of the provided options.
 */
export interface AskUserRequest {
  question: string;
  options: string[];
  allowFreeText: boolean;
}

/** Result of reading `${workspace_root}/AGENT.md` — project-level memory
 *  the agent prepends to its system prompt. Empty when no workspace is
 *  configured or the file is missing. */
export interface AgentMdPayload {
  path: string | null;
  content: string;
  truncated: boolean;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

/** One row of the model-managed plan. `activeForm` is the present-continuous
 *  variant shown next to the in-progress status dot. */
export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
}
