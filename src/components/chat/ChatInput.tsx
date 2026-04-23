import { toast } from 'sonner';
import { ModelSelector } from '@/components/settings/ModelSelector';
import { PromptInputBox } from '@/components/ui/ai-prompt-box';
import { useSettingsStore } from '@/store/settingsStore';
import { useChatStore } from '@/store/chatStore';
import { parseSlashMode, SLASH_COMMANDS } from '@/lib/slash';
import { ModeSelector } from './ModeSelector';

interface ChatInputProps {
  onSend: (content: string, files?: File[]) => void;
  /** Called when the user submits while a stream is already running. The
   *  raw text + files are stashed on the conversation's pending queue; the
   *  text is NOT slash-parsed here — whoever pops the chip later re-parses
   *  so `/plan do X` correctly applies at pop time, not at queue time. */
  onEnqueue?: (content: string, files: File[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
}

/** "On" maps to medium per ChatGPT-style defaults; users wanting finer
 *  control (low/high) still have the settings panel. */
const THINKING_ON_EFFORT = 'medium' as const;

export function ChatInput({
  onSend,
  onEnqueue,
  onStop,
  isStreaming = false,
}: ChatInputProps) {
  const { globalSettings, saveGlobalSettings } = useSettingsStore();

  const handleThinkingToggle = (next: boolean) => {
    void saveGlobalSettings({
      ...globalSettings,
      thinkingEffort: next ? THINKING_ON_EFFORT : 'off',
    });
  };

  const handleSend = async (text: string, files: File[]) => {
    if (!text.trim() && files.length === 0) return;

    // Stream in flight → park the raw payload on the queue and clear the
    // composer. The QueuedChips row above renders a send button to send
    // each one once the user has seen the assistant's response.
    if (isStreaming) {
      if (onEnqueue) {
        onEnqueue(text, files);
        return;
      }
      // No queue wired up — fall through to the old "drop silently" behavior.
      return;
    }

    const { mode, remainder } = parseSlashMode(text);
    if (mode) {
      const chat = useChatStore.getState();
      const conv = chat.conversations.find(
        (c) => c.id === chat.currentConversationId,
      );
      if (!conv) {
        toast.error('Start a conversation first');
        return;
      }
      // Await so `useAiSdkChat` below reads the new mode when building
      // the turn's toolset; the store's optimistic update runs synchronously
      // anyway, but awaiting keeps the code robust if that ever changes.
      await chat.setConversationMode(conv.id, mode);
      if (remainder.length === 0 && files.length === 0) {
        toast.success(`Mode → ${mode}`);
        return;
      }
      // Silent switch when there's a follow-up prompt — the incoming
      // message itself is feedback enough that the mode took effect.
      onSend(remainder, files);
      return;
    }

    onSend(text, files);
  };

  return (
    <div className="px-4 pb-5 pt-2" data-chat-print="hide">
      <div className="max-w-3xl mx-auto">
        <PromptInputBox
          onSend={handleSend}
          onStop={onStop}
          isLoading={isStreaming}
          // Let the textarea stay editable + Enter still submit while a
          // stream is running; `handleSend` above re-routes to `onEnqueue`
          // so submissions land on the pending queue rendered by
          // <QueuedChips />.
          allowSubmitWhileLoading={Boolean(onEnqueue)}
          placeholder="Ask anything"
          thinkingEnabled={globalSettings.thinkingEffort !== 'off'}
          onThinkingToggle={handleThinkingToggle}
          slashCommands={SLASH_COMMANDS}
          bottomStartSlot={
            <div className="flex items-center gap-1">
              <ModelSelector />
              <ModeSelector />
            </div>
          }
        />
        <p className="text-xs text-muted-foreground text-center mt-2.5">
          {isStreaming && onEnqueue
            ? 'Press Enter to queue a follow-up — it stays pending until you send it.'
            : 'AI can make mistakes. Verify important information.'}
        </p>
      </div>
    </div>
  );
}
