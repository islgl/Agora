import { useEffect } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useAiSdkChat } from '@/hooks/useAiSdkChat';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ChatWelcome } from './ChatWelcome';
import { ApprovalGate } from './ApprovalGate';
import { AskUserGate } from './AskUserGate';
import { SubagentsIndicator } from './SubagentsIndicator';
import { AgentMdChip } from './AgentMdChip';
import { QueuedChips } from './QueuedChips';
import { toast } from 'sonner';
import { celebrateFirstSendOnce } from '@/lib/celebration';
import { parseSlashMode } from '@/lib/slash';
import type { QueuedMessage } from '@/store/chatStore';

export function ChatArea() {
  const {
    currentConversationId,
    conversations,
    messages,
    activeStreams,
    loadMessages,
    loadTodos,
    renameConversation,
    createConversation,
    switchBranch,
    enqueueMessage,
    cancelQueuedMessage,
    setConversationMode,
  } = useChatStore();

  const { modelConfigs, activeModelId, resolveModelConfig, globalSettings } =
    useSettingsStore();
  const { sendMessage, cancel } = useAiSdkChat();

  const isStreaming = currentConversationId
    ? Boolean(activeStreams[currentConversationId])
    : false;
  const cancelCurrent = () => {
    if (currentConversationId) void cancel(currentConversationId);
  };

  // Web search is now a purely global capability. When on, the native
  // search tool is attached to the request and the model decides whether
  // to call it; when off, no search tool is sent.
  const effectiveWebSearch = globalSettings.webSearchEnabled;

  const currentConversation = conversations.find(
    (c) => c.id === currentConversationId
  );
  const currentMessages = currentConversationId
    ? (messages[currentConversationId] ?? [])
    : [];

  useEffect(() => {
    if (currentConversationId) {
      loadMessages(currentConversationId);
      void loadTodos(currentConversationId);
    }
  }, [currentConversationId, loadMessages, loadTodos]);

  const requireActiveModel = () => {
    const modelConfig = modelConfigs.find((m) => m.id === activeModelId);
    if (!modelConfig) {
      toast.error('Please configure a model in Settings first');
      return null;
    }
    if (!globalSettings.apiKey.trim()) {
      toast.error('Please set your API key in Settings → Providers');
      return null;
    }
    return modelConfig;
  };

  const handleSend = async (content: string, files: File[] = []) => {
    const modelConfig = requireActiveModel();
    if (!modelConfig) return;

    const autoTitle = content.slice(0, 40) + (content.length > 40 ? '…' : '');

    let conversationId = currentConversationId;
    let history = currentMessages;

    if (!conversationId) {
      const conv = await createConversation(autoTitle, activeModelId ?? '');
      conversationId = conv.id;
      history = [];
      // Apply the mode the user pre-selected on the welcome screen, if
      // any. Await so `sendMessage` below reads the fresh mode when
      // building the system prompt / turn context.
      const chat = useChatStore.getState();
      const pending = chat.pendingMode;
      if (pending && pending !== 'chat') {
        await chat.setConversationMode(conv.id, pending);
      }
      if (pending) chat.setPendingMode(null);
    } else if (
      currentMessages.length === 0 &&
      currentConversation?.title === 'New conversation'
    ) {
      renameConversation(conversationId, autoTitle);
    }

    const attachments = await Promise.all(files.map(fileToAttachment));

    try {
      const resolved = resolveModelConfig(modelConfig);
      await sendMessage(conversationId, history, content, resolved, effectiveWebSearch, {
        attachments,
      });
      // Fire confetti the very first time the user ever sends — one-shot,
      // persisted via localStorage so it doesn't repeat across reloads.
      celebrateFirstSendOnce();
    } catch (err) {
      toast.error(String(err));
    }
  };

  const handleEdit = async (messageId: string, newContent: string) => {
    if (!currentConversationId) return;
    const modelConfig = requireActiveModel();
    if (!modelConfig) return;
    const target = currentMessages.find((m) => m.id === messageId);
    if (!target) return;

    // History = active path up to (but not including) the message being replaced.
    const cutIdx = currentMessages.findIndex((m) => m.id === messageId);
    const history = cutIdx >= 0 ? currentMessages.slice(0, cutIdx) : currentMessages;
    const resolved = resolveModelConfig(modelConfig);
    try {
      await sendMessage(
        currentConversationId,
        history,
        newContent,
        resolved,
        effectiveWebSearch,
        { parentMessageId: target.parentId }
      );
    } catch (err) {
      toast.error(String(err));
    }
  };

  const handleRegenerate = async (messageId: string, modelConfigId?: string) => {
    if (!currentConversationId) return;
    const baseModel = requireActiveModel();
    if (!baseModel) return;
    const chosenModel = modelConfigId
      ? modelConfigs.find((m) => m.id === modelConfigId) ?? baseModel
      : baseModel;
    const resolved = resolveModelConfig(chosenModel);
    // Pass the full active path — the hook truncates at the branching point.
    try {
      await sendMessage(
        currentConversationId,
        currentMessages,
        '',
        resolved,
        effectiveWebSearch,
        { regenerateOfAssistantId: messageId }
      );
    } catch (err) {
      toast.error(String(err));
    }
  };

  const handleSwitchBranch = async (messageId: string) => {
    if (!currentConversationId) return;
    try {
      await switchBranch(currentConversationId, messageId);
    } catch (err) {
      toast.error(String(err));
    }
  };

  const handleEnqueue = (content: string, files: File[]) => {
    // Queueing pre-conversation makes no sense — no stream can be in
    // flight yet — but guard just in case the welcome-path ever wires
    // this through.
    if (!currentConversationId) return;
    enqueueMessage(currentConversationId, content, files);
  };

  const handleSendQueued = async (msg: QueuedMessage) => {
    if (!currentConversationId) return;
    // Pop the chip before dispatching so a second click (or a re-render
    // that re-uses a stale reference) can't double-send.
    cancelQueuedMessage(currentConversationId, msg.id);
    const { mode, remainder } = parseSlashMode(msg.content);
    if (mode) {
      await setConversationMode(currentConversationId, mode);
      if (!remainder && msg.files.length === 0) {
        toast.success(`Mode → ${mode}`);
        return;
      }
    }
    if (!remainder && msg.files.length === 0) return;
    await handleSend(remainder, msg.files);
  };

  /* ── 无会话欢迎页 ── */
  if (!currentConversationId) {
    return (
      <div className="flex flex-col h-full min-h-0 min-w-0 overflow-hidden">
        <ChatWelcome />
        <ApprovalGate />
        <AskUserGate />
        <div
          className="flex justify-end items-center gap-2 px-4 pt-1"
          data-chat-print="hide"
        >
          <AgentMdChip />
          <SubagentsIndicator />
        </div>
        <ChatInput onSend={handleSend} onStop={cancelCurrent} isStreaming={isStreaming} />
      </div>
    );
  }

  /* ── 活跃会话 ── */
  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 overflow-hidden">
      <MessageList
        messages={currentMessages}
        isStreaming={isStreaming}
        onEdit={handleEdit}
        onRegenerate={handleRegenerate}
        onSwitchBranch={handleSwitchBranch}
      />
      <ApprovalGate />
      <AskUserGate />
      <div className="flex justify-end px-4 pt-1" data-chat-print="hide">
        <SubagentsIndicator />
      </div>
      {currentConversationId && (
        <QueuedChips
          conversationId={currentConversationId}
          isStreaming={isStreaming}
          onSend={handleSendQueued}
        />
      )}
      <ChatInput
        onSend={handleSend}
        onEnqueue={handleEnqueue}
        onStop={cancelCurrent}
        isStreaming={isStreaming}
      />
    </div>
  );
}

/** Read a File into a base64 data URL for sending as an image part. */
function fileToAttachment(
  file: File,
): Promise<{ dataUrl: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () =>
      resolve({
        dataUrl: String(reader.result),
        mimeType: file.type || 'application/octet-stream',
      });
    reader.readAsDataURL(file);
  });
}
