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
  | { type: 'step_start'; id: string }
  /** A user message that arrived mid-turn and was spliced into the next
   *  tool_result as a `<user-interrupt>` block. Persisted as a part of
   *  the streaming assistant message so the transcript shows a faithful
   *  trail of what the user said and when. `at` is the millis timestamp
   *  the user actually submitted. */
  | { type: 'user_interrupt'; text: string; at: number };

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

/** Embedding provider for auto-memory. Only OpenAI is wired up — Anthropic
 *  has no native embeddings API, and Gemini was dropped since we don't have
 *  access to it. */
export type EmbeddingProvider = 'openai';

export interface EmbeddingConfig {
  id: string;
  name: string;
  provider: EmbeddingProvider;
  model: string;
  /** Gateway-level routing id injected as the `X-Model-Provider-Id`
   *  header on every outbound request. Matches the enterprise-gateway
   *  pattern where `/v1/embeddings` is OpenAI-compatible but the
   *  downstream provider (e.g. `tongyi`, `qwen`, `openai`) is selected
   *  via a header. Empty = don't inject the header. */
  providerId: string;
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
  /** JSON blob for hook config. Structure is `{ preToolUse?: [...],
   *  postToolUse?: [...] }` where each entry is `{ matcher, command,
   *  failMode }`. Shape mirrors Claude Code's hook config; the frontend
   *  owns the schema and Rust treats it as an opaque blob. */
  hooksJson: string;
  /** ID of the model selected via "Use" in Settings → Models. Empty until
   *  the user has picked one; loadModelConfigs still falls back to
   *  configs[0] if this points at a deleted model. */
  activeModelId: string;
  /** Provider of the *active* embedding config. Kept in sync with the
   *  active entry in `embeddingConfigsJson` so older code paths that read
   *  only these two fields keep working. */
  embeddingProvider: string;
  /** Model id of the active embedding config (e.g.
   *  `text-embedding-3-small`). */
  embeddingModel: string;
  /** JSON blob owning the embedding-config list + active id. Shape:
   *  `{"configs":EmbeddingConfig[],"activeId":string}`. Default `"{}"` means
   *  "not yet seeded" — the store migrates the legacy single-config fields
   *  into a first entry on load. */
  embeddingConfigsJson: string;
  /** Shared endpoint for all embedding traffic (set in Providers tab).
   *  Empty = fall back to the chat-side `baseUrlOpenai`. Routing within
   *  the gateway happens through each embedding-config's `providerId`
   *  header, so we don't need a per-provider URL override. */
  baseUrlEmbeddingCommon: string;
  /** When true, the post-turn extractor runs and persists candidates.
   *  When false, the store is read-only — only explicit `remember` calls
   *  mutate it. Recall still happens either way. */
  autoMemoryEnabled: boolean;
  /** When true, pressing Option twice should surface Agora and start a
   *  fresh conversation from the background. */
  quickLaunchEnabled: boolean;
}

export interface BackgroundStatus {
  menubarReady: boolean;
  quickLaunchEnabled: boolean;
  quickLaunchActive: boolean;
  quickLaunchRequiresPermission: boolean;
  quickLaunchMessage: string;
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

/** One file inside the Brand Layer (~/.agora/config/*.md). Path is null
 *  when the file doesn't exist on disk — the UI treats that the same as
 *  an empty file. */
export interface BrandSection {
  path: string | null;
  content: string;
  truncated: boolean;
}

/** Snapshot of all five Brand Layer files. Loaded on app start and
 *  refreshed before every chat turn so user edits land in the next
 *  system prompt without a manual reload. */
export interface BrandPayload {
  soul: BrandSection;
  user: BrandSection;
  tools: BrandSection;
  memory: BrandSection;
  agents: BrandSection;
  configDir: string;
}

/** Which Brand file the frontend is writing to. AGENTS.md is deliberately
 *  excluded — it's system-managed. */
export type BrandEditableFile = 'SOUL.md' | 'USER.md' | 'TOOLS.md' | 'MEMORY.md';

/** Metadata row for one Wiki page. Mirrors `commands::wiki::WikiPage`. */
export interface WikiPage {
  relPath: string;
  title: string;
  tags: string[];
  category: string | null;
  summary: string | null;
  updatedAt: string | null;
  sources: string[];
  sizeBytes: number;
}

export interface WikiPageContents {
  relPath: string;
  content: string;
  frontmatter: unknown;
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
