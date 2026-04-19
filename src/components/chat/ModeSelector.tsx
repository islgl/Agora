import { ChevronDown, MessageSquare, Target, Zap } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useChatStore } from '@/store/chatStore';
import type { ConversationMode } from '@/types';

/**
 * Dropdown pill next to ModelSelector. Flips the current conversation's
 * mode between chat / plan / execute. On the welcome screen (no current
 * conversation) the chip stays visible and writes to `pendingMode`
 * instead — `ChatArea.handleSend` applies that to the first conversation
 * it creates, then clears the stash.
 *
 * Session-allow bookkeeping for Execute mode is owned by
 * `chatStore.setConversationMode` so every entry point (this dropdown,
 * the `/execute` slash command, the `exit_plan_mode` tool) behaves
 * identically.
 */

interface ModeMeta {
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Tailwind class tuple for the chip when that mode is active. */
  chipClass: string;
}

const MODE_META: Record<ConversationMode, ModeMeta> = {
  chat: {
    label: 'Chat',
    hint: 'Default. All tools available, writes ask per call.',
    icon: MessageSquare,
    chipClass: 'text-muted-foreground',
  },
  plan: {
    label: 'Plan',
    hint: 'Read-only investigation. Write/bash stripped.',
    icon: Target,
    chipClass: 'text-blue-600 dark:text-blue-400',
  },
  execute: {
    label: 'Execute',
    hint: 'write_file / edit_file auto-allowed this session; bash still asks.',
    icon: Zap,
    chipClass: 'text-amber-600 dark:text-amber-400',
  },
};

export function ModeSelector() {
  const currentConversationId = useChatStore((s) => s.currentConversationId);
  const current = useChatStore((s) =>
    s.conversations.find((c) => c.id === currentConversationId),
  );
  const pendingMode = useChatStore((s) => s.pendingMode);
  const setConversationMode = useChatStore((s) => s.setConversationMode);
  const setPendingMode = useChatStore((s) => s.setPendingMode);

  const mode: ConversationMode = current
    ? (current.mode ?? 'chat')
    : (pendingMode ?? 'chat');
  const meta = MODE_META[mode];
  const Icon = meta.icon;

  const handlePick = async (next: ConversationMode) => {
    if (next === mode) return;
    if (current) {
      await setConversationMode(current.id, next);
    } else {
      // No conversation yet — stash the choice until the next send
      // creates one. `chat` is the default, so null the stash.
      setPendingMode(next === 'chat' ? null : next);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs
                    hover:bg-accent transition-colors ${meta.chipClass}`}
        title={meta.hint}
      >
        <Icon className="size-3.5 shrink-0" />
        <span>{meta.label}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[14rem]">
        {(Object.keys(MODE_META) as ConversationMode[]).map((m) => {
          const item = MODE_META[m];
          const ItemIcon = item.icon;
          const active = m === mode;
          return (
            <DropdownMenuItem
              key={m}
              onClick={() => void handlePick(m)}
              className="flex items-start gap-2 py-2"
            >
              <ItemIcon className={`size-4 shrink-0 mt-0.5 ${item.chipClass}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{item.label}</span>
                  {active && (
                    <span className="text-[10px] text-muted-foreground">
                      active
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground leading-snug">
                  {item.hint}
                </p>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
