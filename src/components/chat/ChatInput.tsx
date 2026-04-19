import { toast } from 'sonner';
import { ModelSelector } from '@/components/settings/ModelSelector';
import { PromptInputBox } from '@/components/ui/ai-prompt-box';
import { useSettingsStore } from '@/store/settingsStore';
import { useChatStore } from '@/store/chatStore';
import type { ConversationMode } from '@/types';
import { ModeSelector } from './ModeSelector';

interface ChatInputProps {
  onSend: (content: string, files?: File[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
}

/** "On" maps to medium per ChatGPT-style defaults; users wanting finer
 *  control (low/high) still have the settings panel. */
const THINKING_ON_EFFORT = 'medium' as const;

const SLASH_MODE: Record<string, ConversationMode> = {
  '/chat': 'chat',
  '/plan': 'plan',
  '/execute': 'execute',
};

const SLASH_COMMANDS = [
  { command: '/chat', description: 'Switch to chat mode' },
  { command: '/plan', description: 'Switch to plan mode (readonly)' },
  { command: '/execute', description: 'Switch to execute mode (auto-allow writes)' },
];

export function ChatInput({ onSend, onStop, isStreaming = false }: ChatInputProps) {
  const { globalSettings, saveGlobalSettings } = useSettingsStore();

  const handleThinkingToggle = (next: boolean) => {
    void saveGlobalSettings({
      ...globalSettings,
      thinkingEffort: next ? THINKING_ON_EFFORT : 'off',
    });
  };

  const handleSend = async (text: string, files: File[]) => {
    if (isStreaming) return;
    if (!text.trim() && files.length === 0) return;

    const trimmed = text.trim();
    // Parse `/<cmd>` followed by optional args/prompt. If the first token is
    // a known mode-switch command, apply the switch first; any remaining
    // text is forwarded as a normal user message on the new mode.
    const slashMatch = trimmed.match(/^(\/\S+)(?:\s+([\s\S]+))?$/);
    const leading = slashMatch ? slashMatch[1].toLowerCase() : null;
    const mode = leading ? SLASH_MODE[leading] : undefined;
    if (mode) {
      const chat = useChatStore.getState();
      const conv = chat.conversations.find(
        (c) => c.id === chat.currentConversationId,
      );
      if (!conv) {
        toast.error('Start a conversation first');
        return;
      }
      const remainder = slashMatch?.[2]?.trim() ?? '';
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
          AI can make mistakes. Verify important information.
        </p>
      </div>
    </div>
  );
}
