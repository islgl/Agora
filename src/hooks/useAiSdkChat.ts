import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { invoke } from '@tauri-apps/api/core';
import { v4 as uuidv4 } from 'uuid';
import type { Message, MessagePart, ModelConfig, ThinkingEffort } from '@/types';
import { useChatStore } from '@/store/chatStore';
import { useSettingsStore } from '@/store/settingsStore';
import { modelForConfig } from '@/lib/ai/providers';
import { loadFrontendTools } from '@/lib/ai/tools';
import { planThinking } from '@/lib/ai/thinking';
import { webSearchToolsFor } from '@/lib/ai/web-search';

/**
 * Phase 2 of the Vercel AI SDK migration: feature parity with the Rust
 * orchestrator. Consumes `streamText().fullStream` to surface text,
 * reasoning (thinking), tool calls, tool results, and usage into the
 * existing chat store actions so the UI keeps rendering via the same
 * code path as `useStreamChat`.
 *
 * The hook shape matches `useStreamChat` so `ChatArea` can flip between
 * them with a single line.
 */

export interface SendOptions {
  parentMessageId?: string | null;
  regenerateOfAssistantId?: string;
  overrideModelConfig?: ModelConfig;
  /** Image attachments for the new user message. Stored on the message's
   *  `parts` array and forwarded to the provider as multimodal image parts. */
  attachments?: Array<{ dataUrl: string; mimeType: string }>;
}

const TITLE_DEBOUNCE_MS = 10_000;
const titleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

/**
 * Lower a chat-store Message to the shape the Vercel AI SDK expects. User
 * messages with image parts become multimodal (array content) so the model
 * sees the attachments; everything else stays as plain text content.
 */
function toModelMessage(m: Message): ModelMessage {
  if (m.role === 'user' && m.parts && m.parts.some((p) => p.type === 'image')) {
    const text = m.content ?? '';
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; image: string; mediaType?: string }
    > = [];
    for (const part of m.parts) {
      if (part.type === 'image') {
        content.push({ type: 'image', image: part.dataUrl, mediaType: part.mimeType });
      }
    }
    if (text) content.push({ type: 'text', text });
    return { role: 'user', content } as ModelMessage;
  }
  return { role: m.role, content: m.content } as ModelMessage;
}

function maybeRefreshTitle(conversationId: string, modelConfig: ModelConfig) {
  const settings = useSettingsStore.getState().globalSettings;
  if (settings.autoTitleMode === 'off') return;
  const chat = useChatStore.getState();
  const conv = chat.conversations.find((c) => c.id === conversationId);
  if (!conv || conv.titleLocked) return;
  const msgs = chat.messages[conversationId] ?? [];
  if (msgs.length === 0) return;

  if (settings.autoTitleMode === 'first') {
    const firstTurnOnly =
      msgs.length === 2 &&
      msgs[0]?.role === 'user' &&
      msgs[1]?.role === 'assistant';
    if (!firstTurnOnly) return;
    void runTitleRefresh(conversationId, modelConfig);
    return;
  }
  const prev = titleTimers.get(conversationId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    titleTimers.delete(conversationId);
    void runTitleRefresh(conversationId, modelConfig);
  }, TITLE_DEBOUNCE_MS);
  titleTimers.set(conversationId, timer);
}

async function runTitleRefresh(conversationId: string, modelConfig: ModelConfig) {
  const chat = useChatStore.getState();
  const conv = chat.conversations.find((c) => c.id === conversationId);
  if (!conv || conv.titleLocked) return;
  const msgs = chat.messages[conversationId] ?? [];
  if (msgs.length === 0) return;
  try {
    const title = await invoke<string>('summarize_conversation_title', {
      modelConfig,
      messages: msgs,
    });
    const clean = title.trim();
    if (!clean) return;
    await chat.updateConversationTitleAuto(conversationId, clean);
  } catch (err) {
    console.warn('auto-title failed', err);
  }
}

export function useAiSdkChat() {
  const {
    appendMessage,
    appendChunk,
    appendThinking,
    upsertToolCallPart,
    appendToolCallInputDelta,
    appendToolResultPart,
    setMessageUsage,
    markThinkingSkipped,
    persistMessage,
    setActiveStream,
    setActiveLeaf,
    loadMessages,
  } = useChatStore();

  const sendMessage = async (
    conversationId: string,
    history: Message[],
    userContent: string,
    modelConfig: ModelConfig,
    webSearch: boolean = false,
    opts: SendOptions = {}
  ) => {
    const effectiveModel = opts.overrideModelConfig ?? modelConfig;
    const isRegenerate = Boolean(opts.regenerateOfAssistantId);

    let assistantParentId: string | null = null;
    let userMsg: Message | null = null;

    if (isRegenerate) {
      const target = history.find((m) => m.id === opts.regenerateOfAssistantId);
      if (!target) throw new Error('regenerate target not in history');
      assistantParentId = target.parentId;
    } else {
      const parentForUser =
        opts.parentMessageId !== undefined
          ? opts.parentMessageId
          : history[history.length - 1]?.id ?? null;
      const imageParts: MessagePart[] =
        opts.attachments?.map((a) => ({
          type: 'image',
          dataUrl: a.dataUrl,
          mimeType: a.mimeType,
        })) ?? [];
      userMsg = {
        id: uuidv4(),
        conversationId,
        parentId: parentForUser,
        role: 'user',
        content: userContent,
        createdAt: Date.now(),
        // When images are attached, emit a structured parts array so the
        // bubble renders them and the provider path below can reconstruct
        // multimodal content from the same source.
        parts:
          imageParts.length > 0
            ? [...imageParts, { type: 'text', text: userContent }]
            : undefined,
        siblingIndex: 0,
        siblingCount: 1,
      };
      appendMessage(userMsg);
      await persistMessage(userMsg);
      assistantParentId = userMsg.id;
    }

    const assistantMsg: Message = {
      id: uuidv4(),
      conversationId,
      parentId: assistantParentId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      parts: [],
      modelName: effectiveModel.name,
      siblingIndex: 0,
      siblingCount: 1,
    };
    appendMessage(assistantMsg);

    const streamId = uuidv4();
    const abort = new AbortController();
    activeAborts.set(conversationId, abort);
    setActiveStream(conversationId, {
      streamId,
      conversationId,
      assistantMessageId: assistantMsg.id,
    });

    let providerHistory: Message[];
    if (isRegenerate) {
      const cutIdx = history.findIndex((m) => m.id === opts.regenerateOfAssistantId);
      providerHistory = cutIdx > 0 ? history.slice(0, cutIdx) : history.slice();
    } else {
      providerHistory = [...history, userMsg!];
    }

    const modelMessages: ModelMessage[] = providerHistory.map(toModelMessage);

    const settings = useSettingsStore.getState().globalSettings;
    const thinkingEffort: ThinkingEffort = settings.thinkingEffort ?? 'off';
    const plan = planThinking(effectiveModel, thinkingEffort);
    if (plan.skipped) {
      markThinkingSkipped(conversationId, assistantMsg.id);
    }

    // Pre-load tools once per turn. MCP servers are live connections
    // managed by Rust; `list_frontend_tools` is cheap — just a snapshot
    // of whatever is currently connected. Provider-native web search
    // joins the set when the global toggle is on — the model picks
    // whether to invoke it.
    const frontendTools = await loadFrontendTools();
    const tools: ToolSet = webSearch
      ? { ...frontendTools, ...webSearchToolsFor(effectiveModel) }
      : frontendTools;

    const finalize = async () => {
      setActiveStream(conversationId, null);
      activeAborts.delete(conversationId);
      const finalMsg = useChatStore
        .getState()
        .messages[conversationId]?.find((m) => m.id === assistantMsg.id);
      if (finalMsg) {
        try {
          await persistMessage(finalMsg);
          await setActiveLeaf(conversationId, finalMsg.id);
          await loadMessages(conversationId, true);
        } catch (err) {
          console.error('finalize failed', err);
        }
      }
      maybeRefreshTitle(conversationId, effectiveModel);
    };

    try {
      const result = streamText({
        model: modelForConfig(effectiveModel),
        messages: modelMessages,
        tools,
        // Allow a handful of tool-call round trips per user turn — the
        // model will usually settle in 2-3 steps for MCP workflows.
        stopWhen: stepCountIs(20),
        abortSignal: abort.signal,
        providerOptions: plan.providerOptions,
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            if (part.text) appendChunk(conversationId, assistantMsg.id, part.text);
            break;
          case 'reasoning-delta':
            if (part.text) appendThinking(conversationId, assistantMsg.id, part.text);
            break;
          case 'tool-input-start':
            upsertToolCallPart(conversationId, assistantMsg.id, {
              type: 'tool_call',
              id: part.id,
              name: part.toolName,
              input: {},
            });
            break;
          case 'tool-input-delta':
            appendToolCallInputDelta(
              conversationId,
              assistantMsg.id,
              part.id,
              part.delta
            );
            break;
          case 'tool-call':
            upsertToolCallPart(conversationId, assistantMsg.id, {
              type: 'tool_call',
              id: part.toolCallId,
              name: part.toolName,
              input: part.input as unknown,
            });
            break;
          case 'tool-result':
            appendToolResultPart(conversationId, assistantMsg.id, {
              type: 'tool_result',
              call_id: part.toolCallId,
              content: toolOutputToString(part.output),
              is_error: false,
            });
            break;
          case 'tool-error':
            appendToolResultPart(conversationId, assistantMsg.id, {
              type: 'tool_result',
              call_id: part.toolCallId,
              content: formatError(part.error) || 'tool error',
              is_error: true,
            });
            break;
          case 'finish': {
            const usage = part.totalUsage;
            if (usage && (usage.inputTokens != null || usage.outputTokens != null)) {
              setMessageUsage(
                conversationId,
                assistantMsg.id,
                usage.inputTokens ?? 0,
                usage.outputTokens ?? 0
              );
            }
            break;
          }
          case 'error':
            appendChunk(
              conversationId,
              assistantMsg.id,
              `\n\n_Error: ${formatError(part.error)}_`
            );
            break;
          case 'abort':
            // User hit stop — finalize will run via the outer catch flow.
            break;
          default:
            // Ignore text-start/text-end/reasoning-start/reasoning-end,
            // start-step/finish-step, source/file, raw — the store doesn't
            // model these yet.
            break;
        }
      }

      await finalize();
    } catch (err) {
      if (!isAbortError(err)) {
        appendChunk(
          conversationId,
          assistantMsg.id,
          `\n\n_Error: ${formatError(err)}_`
        );
      }
      await finalize();
    }
  };

  const cancel = async (conversationId: string) => {
    const active = useChatStore.getState().activeStreams[conversationId];
    if (!active) return;
    const abort = activeAborts.get(conversationId);
    if (abort) {
      try {
        abort.abort();
      } catch {
        /* noop */
      }
      activeAborts.delete(conversationId);
    }
    setActiveStream(conversationId, null);
    const finalMsg = useChatStore
      .getState()
      .messages[conversationId]?.find((m) => m.id === active.assistantMessageId);
    if (finalMsg && (finalMsg.content.length > 0 || (finalMsg.parts?.length ?? 0) > 0)) {
      try {
        await persistMessage(finalMsg);
        await setActiveLeaf(conversationId, finalMsg.id);
        await loadMessages(conversationId, true);
      } catch (err) {
        console.error('cancel finalize failed', err);
      }
    }
  };

  return { sendMessage, cancel };
}

// Per-conversation AbortController registry. Lives at module scope so
// `cancel()` can reach the controller created inside `sendMessage` without
// routing through zustand (the controller itself isn't serializable).
const activeAborts: Map<string, AbortController> = new Map();

function toolOutputToString(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  // Rust's `invoke_tool` returns `{content, isError}` where `content` is
  // always a string. For non-string outputs (e.g. native AI SDK tools
  // later), stringify so the UI's tool-result renderer has something
  // stable to display.
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function isAbortError(e: unknown): boolean {
  if (!e) return false;
  if (e instanceof Error && e.name === 'AbortError') return true;
  const maybe = e as { name?: string; message?: string };
  return maybe?.name === 'AbortError' || /aborted|abort/i.test(maybe?.message ?? '');
}
