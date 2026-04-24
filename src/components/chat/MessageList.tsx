import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { StreamingIndicator } from './StreamingIndicator';
import { ChatWelcome } from './ChatWelcome';
import { ConversationTodos } from './ConversationTodos';
import type { Message, MessagePart } from '@/types';

interface MessageListProps {
  messages: Message[];
  isStreaming: boolean;
  onEdit: (messageId: string, newContent: string) => void;
  onRegenerate: (messageId: string, modelConfigId?: string) => void;
  onSwitchBranch: (messageId: string) => void;
}

const FADE_PX = 32;
const TOP_FADE_MASK =
  `linear-gradient(to bottom, transparent 0, black ${FADE_PX}px)`;
/** Below this distance from the bottom, "at bottom" snaps back to true. */
const STUCK_TO_BOTTOM_PX = 48;

export function MessageList({
  messages,
  isStreaming,
  onEdit,
  onRegenerate,
  onSwitchBranch,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const jumpToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance < STUCK_TO_BOTTOM_PX);
  };

  // When the assistant calls `ask_user` and the user picks an answer, we
  // append a transient user-role bubble. Appending at the end of the
  // array is correct, but the assistant message itself keeps streaming
  // its response into its own parts array — so visually the assistant's
  // post-ask_user text ends up inside the same bubble, with the
  // transient stranded at the bottom. To get the Claude-Desktop flow
  // (question → user pick → answer), we split the assistant bubble at
  // each `ask_user` tool_result boundary and slot the transient between
  // the halves.
  const renderUnits = useMemo(
    () => buildRenderUnits(messages),
    [messages],
  );

  // Auto-follow new / updated messages only when the user is already at the
  // bottom. Don't fire on `atBottom` transitions — that made the wheel fight
  // a smooth scrollIntoView whenever the user drifted into the sticky zone.
  useEffect(() => {
    if (!atBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // `atBottom` is read but intentionally not in deps: we only want to
    // react to message changes, not to re-trigger when the user scrolls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  if (messages.length === 0) {
    return <ChatWelcome />;
  }

  return (
    <div className="relative flex-1 min-h-0 min-w-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-chat-print="scroller"
        className="h-full overflow-y-auto overflow-x-hidden"
        style={{
          maskImage: TOP_FADE_MASK,
          WebkitMaskImage: TOP_FADE_MASK,
        }}
      >
        <div
          className="max-w-3xl mx-auto px-4 pb-6"
          style={{ paddingTop: FADE_PX }}
        >
          {messages[0]?.conversationId && (
            <ConversationTodos conversationId={messages[0].conversationId} />
          )}
          {renderUnits.map((unit, i) => {
            const prev = i > 0 ? renderUnits[i - 1] : null;
            const showTurnDivider =
              unit.message.role === 'user' &&
              !unit.message.transient &&
              prev?.message.role === 'assistant';
            return (
              <Fragment key={unit.key}>
                {showTurnDivider && (
                  <TurnDivider createdAt={unit.message.createdAt} />
                )}
                <MessageBubble
                  message={unit.message}
                  isStreaming={isStreaming}
                  onEdit={onEdit}
                  onRegenerate={onRegenerate}
                  onSwitchBranch={onSwitchBranch}
                />
              </Fragment>
            );
          })}
          {isStreaming && <StreamingIndicator />}
          <div ref={bottomRef} />
        </div>
      </div>

      {!atBottom && (
        <button
          type="button"
          onClick={() => jumpToBottom('smooth')}
          aria-label="Jump to latest message"
          title="Jump to latest"
          className="absolute left-1/2 bottom-4 -translate-x-1/2
                     flex items-center justify-center size-8 rounded-full
                     bg-card text-foreground hover:bg-accent transition-colors"
          style={{
            boxShadow: '0 0 0 1px var(--border), 0 4px 12px rgba(0,0,0,0.08)',
          }}
        >
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
  );
}

function TurnDivider({ createdAt }: { createdAt: number }) {
  const stamp = new Date(createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <div className="flex items-center gap-3 my-2">
      <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
      <span className="text-[10px] text-muted-foreground shrink-0">{stamp}</span>
      <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
    </div>
  );
}

interface RenderUnit {
  key: string;
  message: Message;
}

/**
 * Collapse the stored message list into a render plan:
 * - Normal messages pass through as one unit each.
 * - An assistant message whose parts contain one or more `ask_user`
 *   tool_result pairs, followed in the array by matching transient user
 *   bubbles, is split into N+1 slices at the tool_result boundaries.
 *   Each transient is slotted between the corresponding slices. A
 *   unique `key` suffix keeps React's reconciliation happy across the
 *   synthetic sub-bubbles.
 */
function buildRenderUnits(messages: Message[]): RenderUnit[] {
  // Map each assistant message id → the transient user bubbles that
  // followed it in the array, in order.
  const transientsByAssistant = new Map<string, Message[]>();
  let lastAssistantId: string | null = null;
  for (const m of messages) {
    if (m.role === 'assistant' && !m.transient) {
      lastAssistantId = m.id;
    } else if (m.transient && m.role === 'user' && lastAssistantId) {
      const arr = transientsByAssistant.get(lastAssistantId) ?? [];
      arr.push(m);
      transientsByAssistant.set(lastAssistantId, arr);
    }
  }

  const out: RenderUnit[] = [];
  for (const m of messages) {
    if (m.transient) continue; // placed by the assistant branch below
    if (m.role !== 'assistant' || !transientsByAssistant.has(m.id)) {
      out.push({ key: m.id, message: m });
      continue;
    }
    const transients = transientsByAssistant.get(m.id)!;
    const parts = m.parts ?? [];
    const askUserCallIds = new Set(
      parts
        .filter(
          (p): p is Extract<MessagePart, { type: 'tool_call' }> =>
            p.type === 'tool_call' && p.name === 'ask_user',
        )
        .map((p) => p.id),
    );

    let slice: MessagePart[] = [];
    let sliceIndex = 0;
    let transientIndex = 0;
    const flushSlice = () => {
      if (slice.length === 0) return;
      out.push({
        key: `${m.id}::s${sliceIndex}`,
        message: { ...m, parts: slice },
      });
      slice = [];
      sliceIndex++;
    };

    for (const p of parts) {
      slice.push(p);
      if (p.type === 'tool_result' && askUserCallIds.has(p.call_id)) {
        flushSlice();
        const t = transients[transientIndex];
        if (t) {
          out.push({ key: t.id, message: t });
          transientIndex++;
        }
      }
    }
    flushSlice();
    // Any orphan transients (more picks than boundaries we hit) land at end.
    for (; transientIndex < transients.length; transientIndex++) {
      out.push({
        key: transients[transientIndex].id,
        message: transients[transientIndex],
      });
    }
  }
  return out;
}
