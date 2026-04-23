import { CornerDownRight, Paperclip, Send, X } from 'lucide-react';
import { useAskUserStore } from '@/store/askUserStore';
import { useChatStore, type QueuedMessage } from '@/store/chatStore';
import { usePermissionsStore } from '@/store/permissionsStore';

// Stable empty-array reference so the zustand selector below returns the
// SAME value across renders when the current conversation has no queue.
// A fresh `[]` literal would change identity each render, triggering
// React's "getSnapshot result must be cached" infinite-loop guard.
const EMPTY_QUEUE: readonly QueuedMessage[] = [];

interface QueuedChipsProps {
  conversationId: string;
  isStreaming: boolean;
  /** Called when the user clicks the send button on a chip. The parent
   *  is responsible for removing the chip from the queue and routing
   *  the payload through the normal send pipeline (slash parsing, mode
   *  switch, sendMessage). */
  onSend: (msg: QueuedMessage) => void;
}

/**
 * Horizontal row of pending-message chips shown above the composer while a
 * conversation has queued messages. Drain is manual (per-chip send button) —
 * see the discussion in the commit introducing this component for why we
 * don't auto-send when the stream ends.
 */
export function QueuedChips({
  conversationId,
  isStreaming,
  onSend,
}: QueuedChipsProps) {
  const queue = useChatStore(
    (s) => s.pendingQueue[conversationId] ?? EMPTY_QUEUE,
  );
  const cancel = useChatStore((s) => s.cancelQueuedMessage);
  const askUserPending = useAskUserStore((s) => s.currentPrompt !== null);
  const approvalPending = usePermissionsStore((s) => s.currentPrompt !== null);

  if (queue.length === 0) return null;

  // When a stream is running, text-only messages auto-inject into the
  // next tool-call result as `<user-interrupt>` (see
  // `injectInterrupts` in tools.ts). Messages with attachments can't
  // ride a text-only tool_result and stay in the queue for manual
  // dispatch. Helper text reflects both paths.
  const hasAttachments = queue.some((m) => m.files.length > 0);
  const helperText = (() => {
    if (askUserPending) {
      return 'Answer the clarification above, then use the send button on a chip.';
    }
    if (approvalPending) {
      return 'Resolve the approval prompt above, then use the send button on a chip.';
    }
    if (isStreaming) {
      return hasAttachments
        ? "Attachments can't auto-inject — they'll send as a new turn once the response ends, or use the send button to stop and send now."
        : "These auto-inject on the assistant's next tool call, or send as a new turn once the response ends. Use the send button to stop and send now.";
    }
    return 'Queued — sending as a new turn. Use the dismiss button to discard.';
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
            // Three visual states:
            //   - streaming + text-only → primary tint + inject-arrow prefix (will auto-inject)
            //   - streaming + has files → amber tint (stays pending)
            //   - not streaming → neutral (manual dispatch)
            const willAutoInject = isStreaming && m.files.length === 0;
            const stuckOnAttachments = isStreaming && m.files.length > 0;
            const boxShadow = willAutoInject
              ? '0 0 0 1px color-mix(in oklab, var(--primary) 40%, transparent)'
              : stuckOnAttachments
                ? '0 0 0 1px color-mix(in oklab, #d97757 45%, transparent)'
                : '0 0 0 1px var(--border)';
            const background = willAutoInject
              ? 'color-mix(in oklab, var(--primary) 8%, var(--card))'
              : stuckOnAttachments
                ? 'color-mix(in oklab, #d97757 10%, var(--card))'
                : 'var(--card)';
            return (
              <div
                key={m.id}
                className="flex items-center gap-1 rounded-full pl-3 pr-1 py-1 text-xs text-foreground"
                style={{ boxShadow, background }}
                title={
                  willAutoInject
                    ? "Will auto-inject at the assistant's next tool call. Use the send button to stop the stream and send as a new turn instead."
                    : stuckOnAttachments
                      ? "Attachments can't ride a tool_result. Use the send button to stop the stream and send as a new turn."
                      : m.content
                }
              >
                {willAutoInject && (
                  <CornerDownRight
                    aria-hidden
                    className="size-3 text-primary/80 mr-0.5"
                  />
                )}
                <span className="truncate max-w-[36ch]">{preview}</span>
                {m.files.length > 0 && m.content.length > 0 && (
                  <span className="text-muted-foreground ml-1 inline-flex items-center gap-0.5">
                    · {m.files.length}
                    <Paperclip aria-hidden className="size-3" />
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onSend(m)}
                  // Approvals + ask-user prompts still block — those gates
                  // own the turn and dispatching a new one around them
                  // would skip the user decision. A streaming turn, by
                  // contrast, can be cancelled cleanly.
                  disabled={askUserPending || approvalPending}
                  aria-label={
                    isStreaming
                      ? 'Stop current response and send as a new turn'
                      : 'Send queued message'
                  }
                  className="size-6 rounded-full flex items-center justify-center
                             text-muted-foreground hover:bg-accent hover:text-primary
                             disabled:opacity-40 disabled:cursor-not-allowed"
                  title={
                    isStreaming
                      ? 'Stop the current response and send this as a new turn'
                      : 'Send now'
                  }
                >
                  <Send aria-hidden className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => cancel(conversationId, m.id)}
                  aria-label="Cancel queued message"
                  className="size-6 rounded-full flex items-center justify-center
                             text-muted-foreground hover:bg-accent hover:text-destructive"
                  title="Discard"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
