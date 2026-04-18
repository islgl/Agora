import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Pin, MessageSquare } from 'lucide-react';
import { useChatStore } from '@/store/chatStore';
import { ConversationItem } from './ConversationItem';

interface ConversationListProps {
  search?: string;
}

export function ConversationList({ search = '' }: ConversationListProps) {
  const { conversations, currentConversationId } = useChatStore();
  const [bodyMatches, setBodyMatches] = useState<Set<string> | null>(null);

  // Debounced server-side search across titles + message bodies (FTS5).
  const q = search.trim();
  useEffect(() => {
    if (!q) {
      setBodyMatches(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke<string[]>('search_conversations', { query: q })
        .then((ids) => {
          if (!cancelled) setBodyMatches(new Set(ids));
        })
        .catch((err) => {
          console.warn('search failed', err);
          if (!cancelled) setBodyMatches(new Set());
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

  if (filtered.length === 0) {
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
