import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type {
  ApprovalAnswer,
  ApprovalRequest,
  ToolPermission,
} from '@/types';

/**
 * Permission state for the built-in tool gate.
 *
 * Two tiers of allowlisting:
 * - **Persisted** (`permissions`): `(tool, pattern) → allow|deny` rows that
 *   live in SQLite. Managed via Rust commands `list/save/delete_permission`.
 * - **Session** (`sessionAllows`): in-memory set populated when the user
 *   picks "This session" in the approval prompt. Cleared on reload.
 *
 * The approval queue funnels pending prompts through a single resolver so the
 * user only sees one at a time. Additional requests wait in FIFO order.
 */

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (answer: ApprovalAnswer) => void;
}

/**
 * Where a session-allow came from. `user` means the user clicked "This
 * session" at an approval prompt — those live until app restart.
 * `mode-execute` means it was auto-injected when a specific conversation
 * entered Execute mode; we drop those when that conversation leaves
 * Execute, so Chat-mode calls re-prompt as expected.
 */
export type SessionAllowSource =
  | { kind: 'user' }
  | { kind: 'mode-execute'; conversationId: string };

export interface SessionAllowEntry {
  pattern: string;
  source: SessionAllowSource;
}

interface PermissionsState {
  permissions: ToolPermission[];
  /** tool_name → session-allow entries (pattern + source). */
  sessionAllows: Record<string, SessionAllowEntry[]>;
  /** The currently visible prompt, or null if nothing is pending. */
  currentPrompt: ApprovalRequest | null;
  /** Queue of requests waiting for the current to resolve. */
  queue: PendingEntry[];
  /** Resolver for `currentPrompt`. */
  currentResolve: ((answer: ApprovalAnswer) => void) | null;

  loadPermissions: () => Promise<void>;
  savePermission: (
    input: Pick<ToolPermission, 'toolName' | 'pattern' | 'decision'>,
  ) => Promise<ToolPermission>;
  deletePermission: (id: string) => Promise<void>;

  addSessionAllow: (
    tool: string,
    pattern: string,
    source?: SessionAllowSource,
  ) => void;
  /** Drop every `mode-execute` allow tagged with this conversation. Called
   *  when a conversation leaves Execute mode so its auto-granted wildcards
   *  don't outlive the mode. */
  removeModeAllowsForConversation: (conversationId: string) => void;
  /** Does a session rule cover this tool + input in the given conversation?
   *  Patterns use the same glob semantics as the Rust side (see
   *  `commands/permissions.rs`). Mode-execute allows only match the
   *  conversation they were added for; user allows apply everywhere. */
  matchSession: (
    tool: string,
    input: unknown,
    conversationId: string | null,
  ) => boolean;

  /** Queue an approval request. Resolves once the user picks an answer. */
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
  /** Called by the UI when the user clicks one of the buttons. */
  answerCurrent: (answer: ApprovalAnswer) => void;
}

export const usePermissionsStore = create<PermissionsState>()((set, get) => ({
  permissions: [],
  sessionAllows: {},
  currentPrompt: null,
  queue: [],
  currentResolve: null,

  loadPermissions: async () => {
    try {
      const list = await invoke<ToolPermission[]>('list_permissions');
      set({ permissions: list });
    } catch (err) {
      console.warn('list_permissions failed', err);
    }
  },

  savePermission: async (input) => {
    const perm = await invoke<ToolPermission>('save_permission', {
      perm: {
        id: '',
        toolName: input.toolName,
        pattern: input.pattern,
        decision: input.decision,
        createdAt: 0,
      },
    });
    set((state) => {
      // Upsert by id; dedupe by (toolName, pattern) in case the backend
      // collapsed a row we thought was separate.
      const filtered = state.permissions.filter(
        (p) =>
          p.id !== perm.id &&
          !(p.toolName === perm.toolName && p.pattern === perm.pattern),
      );
      return { permissions: [perm, ...filtered] };
    });
    return perm;
  },

  deletePermission: async (id) => {
    await invoke('delete_permission', { id });
    set((state) => ({
      permissions: state.permissions.filter((p) => p.id !== id),
    }));
  },

  addSessionAllow: (tool, pattern, source = { kind: 'user' }) => {
    set((state) => {
      const existing = state.sessionAllows[tool] ?? [];
      const sourceKey = sourceSignature(source);
      const already = existing.some(
        (e) => e.pattern === pattern && sourceSignature(e.source) === sourceKey,
      );
      if (already) return state;
      return {
        sessionAllows: {
          ...state.sessionAllows,
          [tool]: [...existing, { pattern, source }],
        },
      };
    });
  },

  removeModeAllowsForConversation: (conversationId) => {
    set((state) => {
      const next: Record<string, SessionAllowEntry[]> = {};
      let changed = false;
      for (const [tool, entries] of Object.entries(state.sessionAllows)) {
        const filtered = entries.filter(
          (e) =>
            !(
              e.source.kind === 'mode-execute' &&
              e.source.conversationId === conversationId
            ),
        );
        if (filtered.length !== entries.length) changed = true;
        if (filtered.length > 0) next[tool] = filtered;
      }
      return changed ? { sessionAllows: next } : state;
    });
  },

  matchSession: (tool, input, conversationId) => {
    const entries = get().sessionAllows[tool];
    if (!entries || entries.length === 0) return false;
    return entries.some((e) => {
      // mode-execute entries only apply to the conversation that created
      // them. Without this scope check, a session-allow injected when
      // conversation A entered Execute would silently leak into
      // chat-mode conversation B.
      if (e.source.kind === 'mode-execute') {
        if (e.source.conversationId !== conversationId) return false;
      }
      return matchesPatternLocal(tool, e.pattern, input);
    });
  },

  requestApproval: (req) =>
    new Promise<ApprovalAnswer>((resolve) => {
      const state = get();
      if (state.currentPrompt) {
        set({ queue: [...state.queue, { request: req, resolve }] });
      } else {
        set({ currentPrompt: req, currentResolve: resolve });
      }
    }),

  answerCurrent: (answer) => {
    const state = get();
    const resolve = state.currentResolve;
    if (resolve) resolve(answer);
    const [next, ...rest] = state.queue;
    if (next) {
      set({
        currentPrompt: next.request,
        currentResolve: next.resolve,
        queue: rest,
      });
    } else {
      set({ currentPrompt: null, currentResolve: null, queue: [] });
    }
  },
}));

/**
 * Local glob-ish matcher that mirrors the Rust side's `matches_pattern`.
 * Intentionally tiny — we only need it to keep session allow decisions in
 * sync without a Rust round-trip.
 *
 * - empty pattern → match anything
 * - `bash` / `bash_background` → match against `input.command`
 * - else → match against `input.path` or `input.cwd`
 *
 * Pattern grammar: `*` is the only wildcard. It matches any run of characters
 * (including spaces and path separators — matches Rust's `literal_separator(false)`).
 * `?` matches one char. No bracket/class support — keep aligned with globset.
 */
function matchesPatternLocal(
  tool: string,
  pattern: string,
  input: unknown,
): boolean {
  if (pattern === '') return true;
  const obj = (input ?? {}) as Record<string, unknown>;
  let target: string | undefined;
  if (tool === 'bash' || tool === 'bash_background') {
    target = typeof obj.command === 'string' ? obj.command : undefined;
  } else {
    target =
      typeof obj.path === 'string'
        ? obj.path
        : typeof obj.cwd === 'string'
          ? obj.cwd
          : undefined;
  }
  if (target === undefined) return false;

  const re = globToRegex(pattern);
  return re.test(target);
}

function globToRegex(pattern: string): RegExp {
  let re = '^';
  for (const ch of pattern) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += escapeRegex(ch);
  }
  re += '$';
  return new RegExp(re);
}

function escapeRegex(ch: string): string {
  return /[\\^$.|?*+()[\]{}]/.test(ch) ? `\\${ch}` : ch;
}

function sourceSignature(source: SessionAllowSource): string {
  return source.kind === 'user'
    ? 'user'
    : `mode-execute:${source.conversationId}`;
}
