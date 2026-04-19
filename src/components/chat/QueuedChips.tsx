import { useAskUserStore } from '@/store/askUserStore';
import { useChatStore, type QueuedMessage } from '@/store/chatStore';
import { usePermissionsStore } from '@/store/permissionsStore';

interface QueuedChipsProps {
  conversationId: string;
  isStreaming: boolean;
  /** Called when the user clicks ➤ on a chip. The parent is responsible
   *  for removing the chip from the queue and routing the payload through
   *  the normal send pipeline (slash parsing, mode switch, sendMessage). */
  onSend: (msg: QueuedMessage) => void;
}

/**
 * Horizontal row of pending-message chips shown above the composer while a
 * conversation has queued messages. Drain is manual (per-chip ➤ button) —
 * see the discussion in the commit introducing this component for why we
 * don't auto-send when the stream ends.
 */
export function QueuedChips({
  conversationId,
  isStreaming,
  onSend,
}: QueuedChipsProps) {
  const queue = useChatStore((s) => s.pendingQueue[conversationId] ?? []);
  const cancel = useChatStore((s) => s.cancelQueuedMessage);
  const askUserPending = useAskUserStore((s) => s.currentPrompt !== null);
  const approvalPending = usePermissionsStore((s) => s.currentPrompt !== null);

  if (queue.length === 0) return null;

  const helperText = (() => {
    if (askUserPending) {
      return 'Answer the clarification above, then click ➤ on a chip to send it.';
    }
    if (approvalPending) {
      return 'Resolve the approval prompt above, then click ➤ on a chip to send it.';
    }
    if (isStreaming) {
      return 'Waiting for the current response to finish before sending.';
    }
    return 'Click ➤ to send, ✕ to discard.';
  })();

  return (
    <div className="px-4 pt-1" data-chat-print="hide">
      <div className="max-w-3xl mx-auto space-y-1">
        <p className="text-[11px] text-muted-foreground">{helperText}</p>
        <div className="flex flex-wrap gap-1.5">
          {queue.map((m) => {
            const preview =
              m.content.length > 0
                ? m.content.length > 60
                  ? `${m.content.slice(0, 60)}…`
                  : m.content
                : `${m.files.length} attachment${m.files.length === 1 ? '' : 's'}`;
            return (
              <div
                key={m.id}
                className="flex items-center gap-1 rounded-full bg-card pl-3 pr-1 py-1 text-xs text-foreground"
                style={{ boxShadow: '0 0 0 1px var(--border)' }}
                title={m.content}
              >
                <span className="truncate max-w-[36ch]">{preview}</span>
                {m.files.length > 0 && m.content.length > 0 && (
                  <span className="text-muted-foreground ml-1">
                    · {m.files.length}📎
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onSend(m)}
                  disabled={isStreaming || askUserPending || approvalPending}
                  aria-label="Send queued message"
                  className="size-6 rounded-full flex items-center justify-center
                             text-muted-foreground hover:bg-accent hover:text-primary
                             disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Send now"
                >
                  ➤
                </button>
                <button
                  type="button"
                  onClick={() => cancel(conversationId, m.id)}
                  aria-label="Cancel queued message"
                  className="size-6 rounded-full flex items-center justify-center
                             text-muted-foreground hover:bg-accent hover:text-destructive"
                  title="Discard"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
