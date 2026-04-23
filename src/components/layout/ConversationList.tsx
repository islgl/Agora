import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Pin, MessageSquare, Text } from 'lucide-react';
import { useChatStore } from '@/store/chatStore';
import { ConversationItem } from './ConversationItem';
import type { MessageSearchResult } from '@/types';

interface ConversationListProps {
  search?: string;
}

const MARK_START = '\x01';
const MARK_END = '\x02';

function parseSnippet(raw: string): Array<{ text: string; highlight: boolean }> {
  const result: Array<{ text: string; highlight: boolean }> = [];
  const parts = raw.split(MARK_START);
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) {
      if (parts[i]) result.push({ text: parts[i], highlight: false });
      continue;
    }
    const idx = parts[i].indexOf(MARK_END);
    if (idx === -1) {
      result.push({ text: parts[i], highlight: false });
    } else {
      const highlighted = parts[i].slice(0, idx);
      const rest = parts[i].slice(idx + 1);
      if (highlighted) result.push({ text: highlighted, highlight: true });
      if (rest) result.push({ text: rest, highlight: false });
    }
  }
  return result;
}

interface MessageSnippetItemProps {
  result: MessageSearchResult;
  isActive: boolean;
  onClick: () => void;
}

function MessageSnippetItem({ result, isActive, onClick }: MessageSnippetItemProps) {
  const parts = parseSnippet(result.snippet);
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={onClick}
        className={`w-full text-left px-2 py-1.5 rounded-lg transition-colors ${
          isActive
            ? 'bg-sidebar-accent text-sidebar-foreground'
            : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
        }`}
      >
        <div className="text-[10px] text-muted-foreground truncate mb-0.5 font-medium">
          {result.conversationTitle}
        </div>
        <div className="text-xs leading-relaxed line-clamp-2">
          {parts.map((part, i) =>
            part.highlight ? (
              <mark
                key={i}
                className="bg-primary/15 text-primary rounded-[3px] px-0.5 not-italic"
              >
                {part.text}
              </mark>
            ) : (
              <span key={i}>{part.text}</span>
            ),
          )}
        </div>
      </button>
    </li>
  );
}

export function ConversationList({ search = '' }: ConversationListProps) {
  const { conversations, currentConversationId, setCurrentConversation } = useChatStore();
  const [bodyMatches, setBodyMatches] = useState<Set<string> | null>(null);
  const [msgResults, setMsgResults] = useState<MessageSearchResult[]>([]);

  const q = search.trim();
  useEffect(() => {
    if (!q) {
      setBodyMatches(null);
      setMsgResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.all([
        invoke<string[]>('search_conversations', { query: q }),
        invoke<MessageSearchResult[]>('search_messages', { query: q }),
      ])
        .then(([ids, results]) => {
          if (cancelled) return;
          setBodyMatches(new Set(ids));
          setMsgResults(results);
        })
        .catch((err) => {
          console.warn('search failed', err);
          if (!cancelled) {
            setBodyMatches(new Set());
            setMsgResults([]);
          }
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  const filtered = q
    ? conversations.filter((c) => {
        const inTitle = c.title.toLowerCase().includes(q.toLowerCase());
        const inBody = bodyMatches?.has(c.id) ?? false;
        return inTitle || inBody;
      })
    : conversations;

  if (conversations.length === 0) {
    return (
      <div className="px-2 py-4 text-xs text-muted-foreground text-center">
        No conversations yet
      </div>
    );
  }

  const hasConvResults = filtered.length > 0;
  const hasMsgResults = q.length > 0 && msgResults.length > 0;

  if (!hasConvResults && !hasMsgResults) {
    return (
      <div className="px-2 py-4 text-xs text-muted-foreground text-center">
        No results
      </div>
    );
  }

  const pinned = filtered.filter((c) => c.pinned);
  const rest = filtered.filter((c) => !c.pinned);

  return (
    <div className="flex flex-col gap-2">
      {hasConvResults && (
        <>
          {pinned.length > 0 && (
            <Section icon={<Pin className="size-3 fill-current" />} title="Pinned">
              <ul className="flex flex-col gap-0.5 list-none m-0 p-0">
                {pinned.map((conv) => (
                  <ConversationItem
                    key={conv.id}
                    conversation={conv}
                    isActive={conv.id === currentConversationId}
                  />
                ))}
              </ul>
            </Section>
          )}

          {pinned.length > 0 && rest.length > 0 && (
            <hr className="mx-2 my-1 border-0 border-t border-dashed border-sidebar-border/70" />
          )}

          {rest.length > 0 && (
            <Section
              icon={<MessageSquare className="size-3" />}
              title={pinned.length > 0 ? 'All' : undefined}
            >
              <ul className="flex flex-col gap-0.5 list-none m-0 p-0">
                {rest.map((conv) => (
                  <ConversationItem
                    key={conv.id}
                    conversation={conv}
                    isActive={conv.id === currentConversationId}
                  />
                ))}
              </ul>
            </Section>
          )}
        </>
      )}

      {hasMsgResults && (
        <>
          {hasConvResults && (
            <hr className="mx-2 my-1 border-0 border-t border-dashed border-sidebar-border/70" />
          )}
          <Section icon={<Text className="size-3" />} title="Messages">
            <ul className="flex flex-col gap-0.5 list-none m-0 p-0">
              {msgResults.map((r) => (
                <MessageSnippetItem
                  key={r.messageId}
                  result={r}
                  isActive={r.conversationId === currentConversationId}
                  onClick={() => setCurrentConversation(r.conversationId)}
                />
              ))}
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}

interface SectionProps {
  icon: React.ReactNode;
  title?: string;
  children: React.ReactNode;
}

function Section({ icon, title, children }: SectionProps) {
  return (
    <div>
      {title && (
        <div className="flex items-center gap-1.5 px-2 mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          {icon}
          <span>{title}</span>
        </div>
      )}
      {children}
    </div>
  );
}
