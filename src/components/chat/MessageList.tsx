import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { StreamingIndicator } from './StreamingIndicator';
import { ChatWelcome } from './ChatWelcome';
import type { Message } from '@/types';

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
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              isStreaming={isStreaming}
              onEdit={onEdit}
              onRegenerate={onRegenerate}
              onSwitchBranch={onSwitchBranch}
            />
          ))}
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
