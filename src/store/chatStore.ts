import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Conversation, Message, MessagePart } from '@/types';

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
  /** Sidebar multi-select mode. */
  selectionMode: boolean;
  selectedIds: Set<string>;
  /** When set, <PrintOverlay> renders that conversation for window.print(). */
  printOverlayId: string | null;

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
  persistMessage: (msg: Message) => Promise<void>;
  switchBranch: (conversationId: string, messageId: string) => Promise<void>;
  setActiveLeaf: (conversationId: string, messageId: string) => Promise<void>;
  setActiveStream: (conversationId: string, stream: ActiveStream | null) => void;

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
  selectionMode: false,
  selectedIds: new Set<string>(),
  printOverlayId: null,

  setCurrentConversation: (id) => set({ currentConversationId: id }),

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
      const currentConversationId =
        state.currentConversationId === id
          ? (conversations[0]?.id ?? null)
          : state.currentConversationId;
      return { conversations, messages, currentConversationId, activeStreams };
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
    set((state) => ({
      messages: { ...state.messages, [conversationId]: msgs },
    }));
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
      for (const id of state.selectedIds) {
        delete messages[id];
        delete activeStreams[id];
      }
      const currentConversationId =
        state.currentConversationId && state.selectedIds.has(state.currentConversationId)
          ? remaining[0]?.id ?? null
          : state.currentConversationId;
      return {
        conversations: remaining,
        messages,
        activeStreams,
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
