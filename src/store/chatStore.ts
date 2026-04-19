import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type {
  Conversation,
  ConversationMode,
  Message,
  MessagePart,
  Todo,
} from '@/types';
import { usePermissionsStore } from './permissionsStore';

export interface ActiveStream {
  streamId: string;
  conversationId: string;
  assistantMessageId: string;
}

interface ChatState {
  conversations: Conversation[];
  messages: Record<string, Message[]>;
  currentConversationId: string | null;
  /** One in-flight stream per conversation, keyed by conversationId. */
  activeStreams: Record<string, ActiveStream>;
  /** Per-conversation todo list, written by the model via `todo_write` and
   *  read by the Plan UI. `undefined` = not yet hydrated from SQLite;
   *  `[]` = loaded and intentionally empty. */
  todos: Record<string, Todo[]>;
  /** Sidebar multi-select mode. */
  selectionMode: boolean;
  selectedIds: Set<string>;
  /** When set, <PrintOverlay> renders that conversation for window.print(). */
  printOverlayId: string | null;
  /** Mode the user selected on the welcome screen before a conversation
   *  exists. Applied to the first conversation created via `handleSend`,
   *  then cleared. In-memory only; a fresh app session starts at null. */
  pendingMode: ConversationMode | null;

  // Conversation actions
  setCurrentConversation: (id: string | null) => void;
  loadConversations: () => Promise<void>;
  createConversation: (title: string, modelId: string) => Promise<Conversation>;
  /**
   * "New conversation" button / ⌘N entry point. Reuses an existing blank
   * conversation if one already exists (so the sidebar doesn't fill up with
   * "New conversation" rows when the user hammers ⌘N); otherwise falls
   * through to `createConversation`.
   */
  startNewConversation: (modelId: string) => Promise<Conversation>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  setConversationPinned: (id: string, pinned: boolean) => Promise<void>;
  updateConversationTitleAuto: (id: string, title: string) => Promise<void>;
  /** Switch chat/plan/execute for a conversation. Optimistic; persists to
   *  SQLite. Read-only `chatStore` never rejects — invalid modes are caught
   *  by the Rust command. */
  setConversationMode: (id: string, mode: ConversationMode) => Promise<void>;
  /** Stash a mode chosen on the welcome screen. Cleared when consumed. */
  setPendingMode: (mode: ConversationMode | null) => void;

  // Message actions
  loadMessages: (conversationId: string, force?: boolean) => Promise<void>;
  appendMessage: (msg: Message) => void;
  setActivePath: (conversationId: string, msgs: Message[]) => void;
  appendChunk: (conversationId: string, messageId: string, chunk: string) => void;
  appendThinking: (conversationId: string, messageId: string, chunk: string) => void;
  upsertToolCallPart: (
    conversationId: string,
    messageId: string,
    part: Extract<MessagePart, { type: 'tool_call' }>
  ) => void;
  appendToolCallInputDelta: (
    conversationId: string,
    messageId: string,
    callId: string,
    delta: string
  ) => void;
  appendToolResultPart: (
    conversationId: string,
    messageId: string,
    part: Extract<MessagePart, { type: 'tool_result' }>
  ) => void;
  setMessageUsage: (
    conversationId: string,
    messageId: string,
    inputTokens: number,
    outputTokens: number
  ) => void;
  markThinkingSkipped: (conversationId: string, messageId: string) => void;
  /** Append a `step_start` marker to the message's parts. Idempotent on id. */
  appendStepMarker: (
    conversationId: string,
    messageId: string,
    stepId: string
  ) => void;
  persistMessage: (msg: Message) => Promise<void>;
  switchBranch: (conversationId: string, messageId: string) => Promise<void>;
  setActiveLeaf: (conversationId: string, messageId: string) => Promise<void>;
  setActiveStream: (conversationId: string, stream: ActiveStream | null) => void;

  // Todo actions (Phase B · model-managed plan)
  /** Hydrate todos for a conversation from SQLite. Skips the IPC if already
   *  loaded unless `force` is true. */
  loadTodos: (conversationId: string, force?: boolean) => Promise<void>;
  /** Replace the whole todo list for a conversation and persist to SQLite.
   *  Called by the `todo_write` tool's execute handler. */
  saveTodos: (conversationId: string, todos: Todo[]) => Promise<void>;
  /** Local-only setter used by `todo_write` to push the new list into the
   *  store immediately (before the SQLite round trip completes). */
  setTodos: (conversationId: string, todos: Todo[]) => void;

  // Selection-mode actions
  enterSelectionMode: (seedId?: string) => void;
  exitSelectionMode: () => void;
  toggleSelected: (id: string) => void;
  selectAllVisible: (ids: string[]) => void;
  bulkDelete: () => Promise<void>;
  bulkSetPinned: (pinned: boolean) => Promise<void>;

  // Print overlay
  setPrintOverlayId: (id: string | null) => void;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  conversations: [],
  messages: {},
  currentConversationId: null,
  activeStreams: {},
  todos: {},
  selectionMode: false,
  selectedIds: new Set<string>(),
  printOverlayId: null,
  pendingMode: null,

  setCurrentConversation: (id) => set({ currentConversationId: id }),

  setPendingMode: (mode) => set({ pendingMode: mode }),

  setActiveStream: (conversationId, stream) => {
    set((state) => {
      const next = { ...state.activeStreams };
      if (stream) next[conversationId] = stream;
      else delete next[conversationId];
      return { activeStreams: next };
    });
  },

  loadConversations: async () => {
    const conversations = await invoke<Conversation[]>('load_conversations');
    set((state) => {
      // Reconcile: if currentConversationId no longer exists in SQLite,
      // drop it so the UI falls back to the welcome view.
      const stillExists =
        state.currentConversationId &&
        conversations.some((c) => c.id === state.currentConversationId);
      return {
        conversations,
        currentConversationId: stillExists ? state.currentConversationId : null,
      };
    });
  },

  createConversation: async (title, modelId) => {
    const conv = await invoke<Conversation>('create_conversation', { title, modelId });
    set((state) => ({
      conversations: [conv, ...state.conversations],
      currentConversationId: conv.id,
    }));
    return conv;
  },

  startNewConversation: async (modelId) => {
    const state = get();
    // A conversation still titled "New conversation" has never been sent to —
    // `handleSend` rewrites the title on the first turn, and `maybeRefreshTitle`
    // does the same for auto-titled flows. Additionally require the cached
    // messages (if loaded) to be empty so we don't hijack a pre-rename send
    // that might be mid-stream.
    const existingBlank = state.conversations.find((c) => {
      if (c.title !== 'New conversation') return false;
      const cached = state.messages[c.id];
      return !cached || cached.length === 0;
    });
    if (existingBlank) {
      set({ currentConversationId: existingBlank.id });
      return existingBlank;
    }
    return get().createConversation('New conversation', modelId);
  },

  deleteConversation: async (id) => {
    await invoke('delete_conversation', { id });
    set((state) => {
      const conversations = state.conversations.filter((c) => c.id !== id);
      const messages = { ...state.messages };
      delete messages[id];
      const activeStreams = { ...state.activeStreams };
      delete activeStreams[id];
      const todos = { ...state.todos };
      delete todos[id];
      const currentConversationId =
        state.currentConversationId === id
          ? (conversations[0]?.id ?? null)
          : state.currentConversationId;
      return { conversations, messages, currentConversationId, activeStreams, todos };
    });
  },

  renameConversation: async (id, title) => {
    await invoke('rename_conversation', { id, title });
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title, titleLocked: true } : c
      ),
    }));
  },

  setConversationPinned: async (id, pinned) => {
    await invoke('set_conversation_pinned', { id, pinned });
    // Re-fetch so server-side sort order (pinned DESC, created_at DESC) is
    // reflected in the sidebar without us reproducing the sort client-side.
    const conversations = await invoke<Conversation[]>('load_conversations');
    set({ conversations });
  },

  setConversationMode: async (id, mode) => {
    const prev =
      get().conversations.find((c) => c.id === id)?.mode ?? 'chat';
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, mode } : c,
      ),
    }));
    await invoke('set_conversation_mode', { id, mode });

    // Mode-scoped session allows: Execute auto-grants write/edit for the
    // lifetime of the mode on this conversation. Leaving Execute revokes
    // them so Chat/Plan re-prompt as expected. User-clicked "This session"
    // allows are tagged separately and unaffected here.
    const perms = usePermissionsStore.getState();
    if (prev !== 'execute' && mode === 'execute') {
      const source = { kind: 'mode-execute' as const, conversationId: id };
      perms.addSessionAllow('write_file', '', source);
      perms.addSessionAllow('edit_file', '', source);
    } else if (prev === 'execute' && mode !== 'execute') {
      perms.removeModeAllowsForConversation(id);
    }
  },

  updateConversationTitleAuto: async (id, title) => {
    await invoke('update_conversation_title_auto', { id, title });
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id && !c.titleLocked ? { ...c, title } : c
      ),
    }));
  },

  loadMessages: async (conversationId, force = false) => {
    if (!force && get().messages[conversationId]) return;
    const msgs = await invoke<Message[]>('load_messages', { conversationId });
    set((state) => {
      // Guard against a race: on a fresh conversation, `sendMessage` can
      // run `appendMessage(userMsg)` while this call is still awaiting the
      // Rust read. The Rust side returns stale/empty because our writes
      // haven't landed yet — clobbering the store here would silently
      // wipe the in-flight user + assistant bubbles. Non-force calls
      // trust whatever's already in memory.
      if (!force && state.messages[conversationId]) return state;
      // Preserve any transient (UI-only) messages — e.g. ask_user answer
      // bubbles — that aren't in the DB but should stay visible for the
      // rest of the session.
      const existing = state.messages[conversationId] ?? [];
      const transients = existing.filter((m) => m.transient);
      const merged = transients.length > 0 ? [...msgs, ...transients] : msgs;
      return { messages: { ...state.messages, [conversationId]: merged } };
    });
  },

  setActivePath: (conversationId, msgs) => {
    set((state) => ({
      messages: { ...state.messages, [conversationId]: msgs },
    }));
  },

  appendMessage: (msg) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [msg.conversationId]: [
          ...(state.messages[msg.conversationId] ?? []),
          msg,
        ],
      },
    }));
  },

  appendChunk: (conversationId, messageId, chunk) => {
    set((state) => {
      const msgs = state.messages[conversationId] ?? [];
      return {
        messages: {
          ...state.messages,
          [conversationId]: msgs.map((m) => {
            if (m.id !== messageId) return m;
            const parts = m.parts ? [...m.parts] : [];
            const last = parts.length ? parts[parts.length - 1] : undefined;
            if (last && last.type === 'text') {
              parts[parts.length - 1] = { type: 'text', text: last.text + chunk };
            } else {
              parts.push({ type: 'text', text: chunk });
            }
            return { ...m, content: m.content + chunk, parts };
          }),
        },
      };
    });
  },

  appendThinking: (conversationId, messageId, chunk) => {
    set((state) => {
      const msgs = state.messages[conversationId] ?? [];
      return {
        messages: {
          ...state.messages,
          [conversationId]: msgs.map((m) => {
            if (m.id !== messageId) return m;
            const parts = m.parts ? [...m.parts] : [];
            const last = parts.length ? parts[parts.length - 1] : undefined;
            if (last && last.type === 'thinking') {
              parts[parts.length - 1] = { type: 'thinking', text: last.text + chunk };
            } else {
              parts.push({ type: 'thinking', text: chunk });
            }
            // `content` tracks the visible answer only — thinking doesn't
            // bleed into it so copy/export stay clean.
            return { ...m, parts };
          }),
        },
      };
    });
  },

  upsertToolCallPart: (conversationId, messageId, part) => {
    set((state) => {
      const msgs = state.messages[conversationId] ?? [];
      return {
        messages: {
          ...state.messages,
          [conversationId]: msgs.map((m) => {
            if (m.id !== messageId) return m;
            const parts = m.parts ? [...m.parts] : [];
            const idx = parts.findIndex(
              (p) => p.type === 'tool_call' && p.id === part.id
            );
            if (idx >= 0) {
              const prev = parts[idx];
              if (prev.type === 'tool_call') {
                parts[idx] = {
                  type: 'tool_call',
                  id: part.id,
                  name: part.name || prev.name,
                  input: part.input ?? prev.input,
                  // Clear the streaming buffer when the final input lands.
                  inputPartial: undefined,
                };
              }
            } else {
              parts.push(part);
            }
            return { ...m, parts };
          }),
        },
      };
    });
  },

  appendToolCallInputDelta: (conversationId, messageId, callId, delta) => {
    set((state) => {
      const msgs = state.messages[conversationId] ?? [];
      return {
        messages: {
          ...state.messages,
          [conversationId]: msgs.map((m) => {
            if (m.id !== messageId) return m;
            const parts = m.parts ? [...m.parts] : [];
            const idx = parts.findIndex(
              (p) => p.type === 'tool_call' && p.id === callId
            );
            if (idx < 0) return m;
            const prev = parts[idx];
            if (prev.type !== 'tool_call') return m;
            parts[idx] = {
              ...prev,
              inputPartial: (prev.inputPartial ?? '') + delta,
            };
            return { ...m, parts };
          }),
        },
      };
    });
  },

  appendToolResultPart: (conversationId, messageId, part) => {
    set((state) => {
      const msgs = state.messages[conversationId] ?? [];
      return {
        messages: {
          ...state.messages,
          [conversationId]: msgs.map((m) => {
            if (m.id !== messageId) return m;
            const parts = m.parts ? [...m.parts] : [];
            parts.push(part);
            return { ...m, parts };
          }),
        },
      };
    });
  },

  setMessageUsage: (conversationId, messageId, inputTokens, outputTokens) => {
    set((state) => {
      const msgs = state.messages[conversationId] ?? [];
      return {
        messages: {
          ...state.messages,
          [conversationId]: msgs.map((m) =>
            m.id === messageId ? { ...m, inputTokens, outputTokens } : m
          ),
        },
      };
    });
  },

  markThinkingSkipped: (conversationId, messageId) => {
    set((state) => {
      const msgs = state.messages[conversationId] ?? [];
      return {
        messages: {
          ...state.messages,
          [conversationId]: msgs.map((m) =>
            m.id === messageId ? { ...m, thinkingSkipped: true } : m
          ),
        },
      };
    });
  },

  appendStepMarker: (conversationId, messageId, stepId) => {
    set((state) => {
      const msgs = state.messages[conversationId] ?? [];
      return {
        messages: {
          ...state.messages,
          [conversationId]: msgs.map((m) => {
            if (m.id !== messageId) return m;
            const parts = m.parts ? [...m.parts] : [];
            // Idempotent: the SDK can re-emit start-step on retries.
            if (parts.some((p) => p.type === 'step_start' && p.id === stepId)) {
              return m;
            }
            parts.push({ type: 'step_start', id: stepId });
            return { ...m, parts };
          }),
        },
      };
    });
  },

  persistMessage: async (msg) => {
    await invoke('save_message', { message: msg });
  },

  switchBranch: async (conversationId, messageId) => {
    const msgs = await invoke<Message[]>('switch_branch', {
      conversationId,
      messageId,
    });
    set((state) => ({
      messages: { ...state.messages, [conversationId]: msgs },
    }));
  },

  setActiveLeaf: async (conversationId, messageId) => {
    await invoke('set_active_leaf', { conversationId, messageId });
  },

  loadTodos: async (conversationId, force = false) => {
    if (!force && get().todos[conversationId]) return;
    try {
      const todos = await invoke<Todo[]>('get_todos', { conversationId });
      set((state) => ({
        todos: { ...state.todos, [conversationId]: todos },
      }));
    } catch (err) {
      // Missing row / DB hiccup — treat as empty so the UI isn't wedged.
      console.warn('get_todos failed', err);
      set((state) => ({
        todos: { ...state.todos, [conversationId]: [] },
      }));
    }
  },

  setTodos: (conversationId, todos) => {
    set((state) => ({
      todos: { ...state.todos, [conversationId]: todos },
    }));
  },

  saveTodos: async (conversationId, todos) => {
    // Optimistic local update — the Plan UI renders off the store, so the
    // change should be visible without waiting on the IPC.
    set((state) => ({
      todos: { ...state.todos, [conversationId]: todos },
    }));
    await invoke('save_todos', { conversationId, todos });
  },

  enterSelectionMode: (seedId) => {
    set({
      selectionMode: true,
      selectedIds: seedId ? new Set([seedId]) : new Set<string>(),
    });
  },

  exitSelectionMode: () => {
    set({ selectionMode: false, selectedIds: new Set<string>() });
  },

  toggleSelected: (id) => {
    set((state) => {
      const next = new Set(state.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next };
    });
  },

  selectAllVisible: (ids) => {
    set({ selectedIds: new Set(ids) });
  },

  bulkDelete: async () => {
    const ids = Array.from(get().selectedIds);
    for (const id of ids) {
      try {
        await invoke('delete_conversation', { id });
      } catch (err) {
        console.error('bulk delete failed for', id, err);
      }
    }
    // Reconcile in one pass so React re-renders once.
    set((state) => {
      const remaining = state.conversations.filter((c) => !state.selectedIds.has(c.id));
      const messages = { ...state.messages };
      const activeStreams = { ...state.activeStreams };
      const todos = { ...state.todos };
      for (const id of state.selectedIds) {
        delete messages[id];
        delete activeStreams[id];
        delete todos[id];
      }
      const currentConversationId =
        state.currentConversationId && state.selectedIds.has(state.currentConversationId)
          ? remaining[0]?.id ?? null
          : state.currentConversationId;
      return {
        conversations: remaining,
        messages,
        activeStreams,
        todos,
        currentConversationId,
        selectionMode: false,
        selectedIds: new Set<string>(),
      };
    });
  },

  bulkSetPinned: async (pinned) => {
    const ids = Array.from(get().selectedIds);
    for (const id of ids) {
      try {
        await invoke('set_conversation_pinned', { id, pinned });
      } catch (err) {
        console.error('bulk pin failed for', id, err);
      }
    }
    const conversations = await invoke<Conversation[]>('load_conversations');
    set({ conversations, selectionMode: false, selectedIds: new Set<string>() });
  },

  setPrintOverlayId: (id) => set({ printOverlayId: id }),
}));
