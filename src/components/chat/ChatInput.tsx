import { ModelSelector } from '@/components/settings/ModelSelector';
import { PromptInputBox } from '@/components/ui/ai-prompt-box';
import { useSettingsStore } from '@/store/settingsStore';

interface ChatInputProps {
  onSend: (content: string, files?: File[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
}

/** "On" maps to medium per ChatGPT-style defaults; users wanting finer
 *  control (low/high) still have the settings panel. */
const THINKING_ON_EFFORT = 'medium' as const;

export function ChatInput({ onSend, onStop, isStreaming = false }: ChatInputProps) {
  const { globalSettings, saveGlobalSettings } = useSettingsStore();

  const handleSearchToggle = (next: boolean) => {
    void saveGlobalSettings({ ...globalSettings, webSearchEnabled: next });
  };

  const handleThinkingToggle = (next: boolean) => {
    void saveGlobalSettings({
      ...globalSettings,
      thinkingEffort: next ? THINKING_ON_EFFORT : 'off',
    });
  };

  const handleSend = (text: string, files: File[]) => {
    if (isStreaming) return;
    if (!text.trim() && files.length === 0) return;
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
          searchEnabled={globalSettings.webSearchEnabled}
          onSearchToggle={handleSearchToggle}
          thinkingEnabled={globalSettings.thinkingEffort !== 'off'}
          onThinkingToggle={handleThinkingToggle}
          bottomStartSlot={<ModelSelector />}
        />
        <p className="text-xs text-muted-foreground text-center mt-2.5">
          AI can make mistakes. Verify important information.
        </p>
      </div>
    </div>
  );
}
