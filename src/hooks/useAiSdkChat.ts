import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { invoke } from '@tauri-apps/api/core';
import { v4 as uuidv4 } from 'uuid';
import type {
  ConversationMode,
  Message,
  MessagePart,
  ModelConfig,
  ThinkingEffort,
} from '@/types';
import { useChatStore } from '@/store/chatStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useAgentMdStore } from '@/store/agentMdStore';
import { useBrandStore } from '@/store/brandStore';
import { useWikiStore } from '@/store/wikiStore';
import { useAskUserStore } from '@/store/askUserStore';
import { useActivityStore } from '@/store/activityStore';
import { modelForConfig } from '@/lib/ai/providers';
import { loadFrontendTools } from '@/lib/ai/tools';
import { planThinking } from '@/lib/ai/thinking';
import { webSearchToolsFor } from '@/lib/ai/web-search';
import { buildWikiContext } from '@/lib/ai/wiki-selector';
import {
  extractAndStoreMemories,
  fetchAutoMemoryContext,
} from '@/lib/ai/auto-memory';

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
 * Lower a chat-store Message to the shape the Vercel AI SDK expects.
 *
 * - User messages with image parts become multimodal (array content) so the
 *   model sees the attachments.
 * - Assistant messages with tool_call / tool_result parts are expanded into
 *   a sequence: an assistant message carrying its text + tool-call parts,
 *   followed by one `tool` role message per tool_result. Without this, the
 *   provider sees only the final assistant text and believes it never
 *   called any tools — the model then confabulates in follow-up turns
 *   ("I claimed X but didn't actually call the tool"), because its own
 *   execution record is invisible to it.
 * - Everything else stays as plain text content.
 */
function toModelMessages(m: Message): ModelMessage[] {
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
    return [{ role: 'user', content } as ModelMessage];
  }

  if (m.role === 'assistant' && m.parts && m.parts.length > 0) {
    return expandAssistantMessage(m);
  }

  return [{ role: m.role, content: m.content } as ModelMessage];
}

/**
 * Walk an assistant message's parts in order, emitting assistant messages
 * paired with tool messages so every tool-use block is immediately
 * followed by a tool message carrying tool-results for every call in
 * that assistant batch. Providers (notably Anthropic / Bedrock) reject
 * histories where a `tool_use` id has no matching `tool_result` in the
 * next message — that happens when a stream was interrupted between a
 * tool call and its result.
 *
 * Strategy: accumulate text + tool-calls into one assistant "batch".
 * When we see a tool_result part (signal that the current batch is being
 * resolved) AND more assistant content follows, flush the batch as a
 * pair: one `assistant` message with all batched content, then one
 * `tool` message with a result for each call — real result if we have
 * it in this message's parts, synthesized placeholder otherwise. The
 * same flush runs at end-of-message to close any unresolved calls.
 *
 * Thinking / image / step_start parts are skipped.
 */
function expandAssistantMessage(m: Message): ModelMessage[] {
  const parts = m.parts ?? [];

  // Pre-scan so orphan tool_calls can be detected and given a synthetic
  // result without re-walking.
  const resultByCallId = new Map<string, string>();
  for (const p of parts) {
    if (p.type === 'tool_result') resultByCallId.set(p.call_id, p.content);
  }

  const out: ModelMessage[] = [];
  let assistantContent: Array<
    | { type: 'text'; text: string }
    | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  > = [];
  let pendingCalls: Array<{ id: string; name: string }> = [];
  let seenResultInBatch = false;
  let sawText = false;
  let sawToolCall = false;

  const flushBatch = () => {
    if (assistantContent.length === 0 && pendingCalls.length === 0) return;
    out.push({ role: 'assistant', content: assistantContent } as ModelMessage);
    assistantContent = [];
    if (pendingCalls.length > 0) {
      out.push({
        role: 'tool',
        content: pendingCalls.map((c) => ({
          type: 'tool-result' as const,
          toolCallId: c.id,
          toolName: c.name,
          output: {
            type: 'text' as const,
            value:
              resultByCallId.get(c.id) ??
              '[tool call interrupted — no result recorded]',
          },
        })),
      } as ModelMessage);
      pendingCalls = [];
    }
    seenResultInBatch = false;
  };

  for (const part of parts) {
    if (part.type === 'text') {
      // Text arriving after a tool_result opens a new batch.
      if (seenResultInBatch) flushBatch();
      if (part.text) {
        assistantContent.push({ type: 'text', text: part.text });
        sawText = true;
      }
    } else if (part.type === 'tool_call') {
      if (seenResultInBatch) flushBatch();
      assistantContent.push({
        type: 'tool-call',
        toolCallId: part.id,
        toolName: part.name,
        input: part.input,
      });
      pendingCalls.push({ id: part.id, name: part.name });
      sawToolCall = true;
    } else if (part.type === 'tool_result') {
      // Don't emit anything yet — results are paired to their batch at
      // flush time. Flag the batch as "has at least one result so far",
      // which means the *next* non-result part starts a new batch.
      seenResultInBatch = true;
    }
  }

  flushBatch();

  // Stored message has plain text on `m.content` but no usable parts.
  // Emit as a bare assistant text.
  if (out.length === 0 || (!sawText && !sawToolCall && m.content)) {
    return [{ role: 'assistant', content: m.content } as ModelMessage];
  }

  return out;
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
    appendStepMarker,
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

    // Transient messages (e.g. ask_user answer bubbles) are UI-only —
    // skip them; the answer is already on the preceding tool_result.
    const modelMessages: ModelMessage[] = providerHistory
      .filter((m) => !m.transient)
      .flatMap(toModelMessages);

    const settings = useSettingsStore.getState().globalSettings;
    const thinkingEffort: ThinkingEffort = settings.thinkingEffort ?? 'off';
    const plan = planThinking(effectiveModel, thinkingEffort);
    if (plan.skipped) {
      markThinkingSkipped(conversationId, assistantMsg.id);
    }

    // Gateway compatibility: non-official Anthropic endpoints (Bedrock-
    // fronted proxies, PPIO-style gateways) reject the `eager_input_
    // streaming` field the SDK silently adds to every custom tool. Flip
    // `toolStreaming: false` to suppress it. Official direct-Anthropic
    // endpoints keep the default (fast tool-input streaming).
    const providerOptions: Record<string, Record<string, any>> = {
      ...plan.providerOptions,
    };
    if (
      effectiveModel.provider === 'anthropic' &&
      !isOfficialAnthropicBase(effectiveModel.baseUrl)
    ) {
      providerOptions.anthropic = {
        ...(providerOptions.anthropic ?? {}),
        toolStreaming: false,
      };
    }

    // Pre-load tools once per turn. MCP servers are live connections
    // managed by Rust; `list_frontend_tools` is cheap — just a snapshot
    // of whatever is currently connected. Provider-native web search
    // joins the set when the global toggle is on — the model picks
    // whether to invoke it.
    //
    // Plan/execute mode filters the toolset (Phase C). Read at send time
    // so a mode switch mid-conversation takes effect on the next turn.
    const conversationMode =
      useChatStore
        .getState()
        .conversations.find((c) => c.id === conversationId)?.mode ?? 'chat';
    const frontendTools = await loadFrontendTools(conversationMode);
    const tools: ToolSet = webSearch
      ? {
          ...frontendTools,
          ...webSearchToolsFor(effectiveModel, settings.tavilyApiKey),
        }
      : frontendTools;

    // Refresh AGENT.md + Brand files before each turn so edits land in
    // the next system prompt without a manual reload. Both reads are
    // cheap (small files, Rust side). Kicked off in parallel.
    try {
      await Promise.all([
        useAgentMdStore.getState().refresh(),
        useBrandStore.getState().refresh(),
      ]);
    } catch (err) {
      console.warn('brand/agent refresh failed; using cached content', err);
    }

    // Without a nudge, Claude/GPT typically answer from training data even
    // for post-cutoff or entity-specific queries. A one-line system prompt
    // with today's date + a "prefer search over guessing" cue dramatically
    // raises the rate at which the model reaches for the registered tools.
    const agentMd = useAgentMdStore.getState().payload;
    const brand = useBrandStore.getState().payload;

    // Wiki selector runs before the main streamText call so selected
    // pages can ride along in the same system prompt. On regenerate we
    // reuse the just-above user message as the query since `userContent`
    // is empty then. Selector failures return null → no wiki block (not
    // an error).
    const selectorQuery = isRegenerate
      ? providerHistory[providerHistory.length - 1]?.content ?? ''
      : userContent;
    let wikiBlock: string | undefined;
    try {
      const ctx = await buildWikiContext(selectorQuery);
      if (ctx) {
        wikiBlock = ctx.block;
        useWikiStore.getState().setLastInjected(conversationId, ctx.pages);
      } else {
        useWikiStore.getState().setLastInjected(conversationId, []);
      }
    } catch (err) {
      console.warn('wiki context assembly failed', err);
    }

    // Auto-memory semantic recall. Runs in parallel with wiki selector
    // when practical (both share `selectorQuery`). We only block on the
    // memory fetch because its result goes into the system prompt.
    let autoMemoryBlock: string | undefined;
    try {
      const mem = await fetchAutoMemoryContext(selectorQuery);
      if (mem) autoMemoryBlock = mem.block;
    } catch (err) {
      console.warn('auto memory recall failed', err);
    }

    const systemPrompt = buildSystemPrompt({
      webSearch,
      hasTavily: webSearch && settings.tavilyApiKey.trim().length > 0,
      mode: conversationMode,
      agentMd: agentMd.content,
      brand,
      wikiBlock,
      autoMemoryBlock,
      // Only meaningful on brand-new turns (not regenerates). `userContent`
      // is empty on regenerate; hasRememberIntent handles that gracefully.
      userContent: isRegenerate ? undefined : userContent,
    });

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
          await loadMessages(conversationId, true).catch(() => {});
        }
      }
      maybeRefreshTitle(conversationId, effectiveModel);

      // Fire-and-forget auto-memory extraction. The user shouldn't wait
      // on extractor + embedding latency to see their reply finalize —
      // failures are logged inside, not surfaced here.
      if (finalMsg) {
        void extractAndStoreMemories({
          conversationId,
          userMessage: userMsg,
          assistantMessage: finalMsg,
        });

        // Append the turn to today's log so the Dreaming job has a
        // source to distill from. Fire-and-forget — log failures
        // shouldn't block the UI.
        if (userMsg || !isRegenerate) {
          const userText = userMsg?.content ?? '';
          const assistantText = finalMsg.content ?? '';
          if (userText || assistantText) {
            void invoke('append_daily_log', {
              entry: {
                conversationId,
                userText,
                assistantText,
              },
            }).catch((err) => console.warn('append_daily_log failed', err));
            // Mark activity for the idle-triggered Dreaming effect.
            useActivityStore.getState().bump();
          }
        }
      }
    };

    try {
      const result = streamText({
        model: modelForConfig(effectiveModel),
        messages: modelMessages,
        system: systemPrompt,
        tools,
        // Allow a handful of tool-call round trips per user turn — the
        // model will usually settle in 2-3 steps for MCP workflows.
        stopWhen: stepCountIs(20),
        abortSignal: abort.signal,
        providerOptions,
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'start-step':
            // One task per step in the Plan renderer. The SDK doesn't expose
            // a stable step id, so mint our own — it only needs to survive
            // React keying and ordering within a single message.
            appendStepMarker(conversationId, assistantMsg.id, uuidv4());
            break;
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
            console.error('streamText error part', part.error);
            appendChunk(
              conversationId,
              assistantMsg.id,
              formatErrorChunk(part.error, 'stream error')
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
        console.error('streamText threw', err);
        appendChunk(
          conversationId,
          assistantMsg.id,
          formatErrorChunk(err, 'unknown error')
        );
      }
      await finalize();
    }
  };

  const cancel = async (conversationId: string) => {
    const active = useChatStore.getState().activeStreams[conversationId];
    if (!active) return;
    // Unblock any in-flight ask_user prompts so the stream's paused
    // tool.execute() resolves. Without this, hitting Stop while the
    // clarification gate is up leaves an orphaned prompt on screen +
    // a dangling promise in the runtime; the next turn's auto-dispatch
    // would then fire with a stale AskUser state still blocking UI.
    useAskUserStore.getState().cancelPending();
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

/**
 * Providers phrase context-window blowouts differently; match on the few
 * signatures that actually reach us. A false positive here just gives the
 * user a nicer-worded error; a false negative falls back to the raw
 * provider text. Both are acceptable.
 */
const OVERFLOW_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /prompt is too long/i,
  /maximum context length/i,
  /input is too long/i,
  /context window/i,
  /too many tokens/i,
];

function isContextOverflowError(e: unknown): boolean {
  const msg = formatError(e);
  if (!msg) return false;
  return OVERFLOW_PATTERNS.some((re) => re.test(msg));
}

function formatErrorChunk(e: unknown, fallback: string): string {
  if (isContextOverflowError(e)) {
    return '\n\n_Context window exceeded for this model. Start a new conversation to continue._';
  }
  return `\n\n_Error: ${formatError(e) || fallback}_`;
}

function formatError(e: unknown): string {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (e instanceof Error) {
    // AI SDK wraps provider errors in classes like AI_APICallError where
    // `.message` may be empty but the useful detail sits on siblings like
    // `.responseBody`, `.cause`, or `.data`. Check them in turn.
    if (e.message) return e.message;
    const anyErr = e as unknown as Record<string, unknown>;
    const body = anyErr.responseBody ?? anyErr.data ?? anyErr.cause;
    if (typeof body === 'string' && body) return body;
    if (body) {
      try {
        return JSON.stringify(body);
      } catch {
        /* fall through */
      }
    }
    return e.name || '';
  }
  try {
    const s = JSON.stringify(e);
    return s && s !== '{}' ? s : '';
  } catch {
    return String(e);
  }
}

const CONSTITUTION_BLOCK = `<constitution>
Before every response, internally verify:
1. SAFETY — does this cross the <agents> boundaries above? If yes, refuse and explain.
2. PRIVACY — would the answer leak user-private data? If yes, rewrite before sending.
3. IRREVERSIBLE — is an action here hard to undo? If yes, confirm with the user first.
Proceed only when all three pass. Never mention running this check in the user-facing reply.
</constitution>`;

const REMEMBER_TRIGGERS = [
  '请记住',
  '记住',
  '永远记住',
  '以后都要',
  '以后记得',
  'remember that',
  'please remember',
  'keep in mind that',
  'from now on',
  'always use',
];

function hasRememberIntent(userContent: string | undefined): boolean {
  if (!userContent) return false;
  const lower = userContent.toLowerCase();
  return REMEMBER_TRIGGERS.some((t) => lower.includes(t.toLowerCase()));
}

function buildSystemPrompt(opts: {
  webSearch: boolean;
  hasTavily: boolean;
  mode: ConversationMode;
  agentMd?: string;
  brand?: import('@/types').BrandPayload;
  wikiBlock?: string;
  autoMemoryBlock?: string;
  userContent?: string;
}): string | undefined {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  // Brand Layer goes first so identity/safety rules anchor everything
  // that follows. AGENTS.md carries non-negotiables, the other three
  // carry user-editable personality + context. An empty brand (fresh
  // install with no seeded files on disk) is skipped silently.
  const brandBlock = formatBrandBlock(opts.brand);
  if (brandBlock) {
    lines.push(brandBlock);
  }

  // Wiki Layer sits between Brand and the operational prose. Ordering
  // matters: Brand > Wiki > Memory > date/mode/tools. The selector
  // already picked only-relevant pages — if nothing matched, no block.
  if (opts.wikiBlock && opts.wikiBlock.trim()) {
    lines.push(opts.wikiBlock);
  }

  // Auto-memory recall slots in right after the Wiki layer so recalled
  // memories contextualize whatever wiki pages landed above.
  if (opts.autoMemoryBlock && opts.autoMemoryBlock.trim()) {
    lines.push(opts.autoMemoryBlock);
  }

  // Constitutional self-check sits below <brand> so the three rules can
  // reference <agents>. Three items on purpose — Anthropic's practical
  // guidance is that CAI degrades past ~5 rules as attention dilutes.
  lines.push(CONSTITUTION_BLOCK);

  // Remember-intent nudge. We never route on keywords ourselves —
  // trigger phrases like "remember" / "记住" are far too common in
  // ordinary chat. Instead, mark the turn and let the model decide
  // whether the phrase is an actual remember-this request vs. a
  // conversational "note that…".
  if (hasRememberIntent(opts.userContent)) {
    lines.push(
      "The user's latest message contains a remember-intent phrase. If — " +
        'and only if — they are asking you to commit a durable fact about ' +
        'themselves, their preferences, or their project, call the ' +
        '`append_brand_file` tool with the appropriate `file` BEFORE ' +
        'answering. Do not call it for rhetorical "remember that we ' +
        'discussed X" mentions or for content inside quoted code / docs.',
    );
  }

  lines.push(`Today's date is ${today}.`);

  if (opts.agentMd && opts.agentMd.trim()) {
    lines.push(
      '--- Project AGENT.md ---\n' +
        opts.agentMd.trim() +
        '\n--- end AGENT.md ---',
    );
  }

  if (opts.webSearch) {
    const which = opts.hasTavily
      ? "You have web-search tools available (the provider's native tool and `tavily_search` as a gateway-safe fallback)."
      : "You have a web-search tool available.";
    lines.push(
      which,
      'Call it whenever the question involves information that might be newer than your training data, specific real-world entities (products, prices, scores, news, docs, release notes), or anything the user expects to be current. Prefer searching over guessing when you are not confident — a tool call is cheaper than a hallucination. Cite the URLs you rely on.',
    );
  }

  lines.push(
    'Built-in tools: `read_file` / `glob` / `grep` for reading; `write_file` / `edit_file` for changes; `bash` / `bash_background` / `read_task_output` / `stop_task` for shell. Relative paths resolve against the user\'s workspace root. Mutating tools may require user approval — if a call returns "User denied" or "Blocked by policy", stop and explain what you wanted to do instead of retrying. Never run interactive commands (vim, `git rebase -i`, `npm init` wizards) — there is no TTY; they will hang.',
    'Use `todo_write` to plan non-trivial multi-step tasks. Emit the full todo list at the start (every item `pending`), then re-call `todo_write` with the full updated list as work progresses: flip one item to `in_progress` before you start it, and to `completed` as soon as it is actually done. Keep at most one item `in_progress` at a time. Skip `todo_write` for single-step or conversational requests — tracking overhead is not free.',
    'Use `task` to delegate a chunk of heavy investigation (e.g. "find every caller of foo across src/", "compare these 12 files and summarize the pattern"). Subagents are read-only — they cannot write, edit, or run shell. Keep the prompt self-contained (they do not see this conversation). Default `background: false` (wait for the report); set `background: true` only when you want to launch many investigations in parallel or run one very long one — then check back via `read_subagent_output`.',
  );

  if (opts.mode === 'chat') {
    lines.push(
      'Modes: the conversation is in **chat** mode. If the user is asking for a plan, a refactor strategy, or any non-trivial change whose approach is not yet settled, call `enter_plan_mode` first — you will be locked to read tools until the plan is ready and you call `exit_plan_mode`. For direct "do X" requests where the approach is obvious, stay in chat.',
    );
  } else if (opts.mode === 'plan') {
    lines.push(
      'Modes: the conversation is in **plan** mode. Write/edit/bash tools are **runtime-gated** — they will error out with "not available in plan mode" if you call them now. Only read-type tools work (read_file / glob / grep / web search). Investigate the codebase, draft a plan via `todo_write`, present it to the user, and once they have had a chance to react call `exit_plan_mode` — that surfaces a confirmation carrying your plan summary. Only after the user approves does the mode flip back to **chat**, at which point write tools become callable again but still go through individual per-call approval (the user can separately switch to Execute mode if they want to skip those prompts — not your call to make). If the user asks a question before you exit, answer it — do not silently exit. Right after `exit_plan_mode` succeeds you can call write/edit/bash in the same turn; the gate lifts as soon as the mode changes.',
    );
  } else {
    lines.push(
      'Modes: the conversation is in **execute** mode. `write_file` and `edit_file` auto-approve for this session; bash still asks. Stay focused on the todos — flip each to `in_progress` → `completed` via `todo_write` as you go. If you notice the plan was wrong and needs revision, stop and call this out instead of silently diverging.',
    );
  }

  const prompt = lines.join('\n\n').trim();
  return prompt.length > 0 ? prompt : undefined;
}

/**
 * Render the Brand Layer as XML-ish blocks at the top of the system prompt.
 * XML tags help the model visually segment rule-of-law sections from the
 * softer date / tools prose that follows — the same pattern Anthropic
 * recommends for long-context prompt hygiene.
 *
 * Section ordering is deliberate:
 *   1. <agents>  — safety (overrides everything below)
 *   2. <soul>    — personality + user's style overrides
 *   3. <user>    — who the user is
 *   4. <tools>   — their tech preferences
 *
 * Returns null when all five sections are empty (nothing to inject).
 */
function formatBrandBlock(
  brand: import('@/types').BrandPayload | undefined,
): string | null {
  if (!brand) return null;
  const sections: string[] = [];
  const push = (tag: string, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    sections.push(`<${tag}>\n${trimmed}\n</${tag}>`);
  };
  push('agents', brand.agents.content);
  push('soul', brand.soul.content);
  push('user', brand.user.content);
  push('tools', brand.tools.content);
  if (sections.length === 0) return null;
  return `<brand>\n${sections.join('\n\n')}\n</brand>`;
}

function isOfficialAnthropicBase(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).host.toLowerCase();
    return host === 'api.anthropic.com';
  } catch {
    return false;
  }
}

function isAbortError(e: unknown): boolean {
  if (!e) return false;
  if (e instanceof Error && e.name === 'AbortError') return true;
  const maybe = e as { name?: string; message?: string };
  return maybe?.name === 'AbortError' || /aborted|abort/i.test(maybe?.message ?? '');
}
