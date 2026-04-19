import { useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useAskUserStore } from '@/store/askUserStore';
import { useChatStore } from '@/store/chatStore';
import {
  setAskUserHandler,
  clearAskUserHandlerIf,
} from '@/lib/ai/ask-user-broker';
import { AskUserPrompt } from './AskUserPrompt';

/**
 * Bridges the `ask_user` tool's module-level broker to the React tree.
 * Mount once near the chat input, alongside `<ApprovalGate />`. When a
 * clarification request is pending, renders the question card.
 *
 * When the user picks an option or submits free text, we also append a
 * **transient** user-role message to the chat so the conversation reads
 * naturally (mirrors Claude Desktop's ask-user flow). The bubble is
 * UI-only: it's not persisted, and `toModelMessages` skips it so the
 * provider doesn't see a duplicate user turn — the canonical answer
 * already lives on the preceding assistant message's tool_result part.
 */
export function AskUserGate() {
  const currentPrompt = useAskUserStore((s) => s.currentPrompt);
  const queue = useAskUserStore((s) => s.queue);
  const answerCurrent = useAskUserStore((s) => s.answerCurrent);
  const request = useAskUserStore((s) => s.request);

  useEffect(() => {
    setAskUserHandler(request);
    // Identity-aware clear so a stale cleanup (StrictMode dev double-
    // mount, or welcome↔active branch swap in ChatArea) can't wipe the
    // handler just installed by a fresh mount.
    return () => clearAskUserHandlerIf(request);
  }, [request]);

  const handleAnswer = (answer: string) => {
    const chat = useChatStore.getState();
    const conversationId = chat.currentConversationId;
    const text = answer.trim();
    if (conversationId && text) {
      const msgs = chat.messages[conversationId] ?? [];
      const parentId = msgs[msgs.length - 1]?.id ?? null;
      chat.appendMessage({
        id: uuidv4(),
        conversationId,
        parentId,
        role: 'user',
        content: text,
        createdAt: Date.now(),
        siblingIndex: 0,
        siblingCount: 1,
        transient: true,
      });
    }
    answerCurrent(answer);
  };

  if (!currentPrompt) return null;
  return (
    <AskUserPrompt
      request={currentPrompt}
      queueSize={queue.length}
      onAnswer={handleAnswer}
    />
  );
}
