import { useEffect, useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { AppSidebar } from '@/components/layout/AppSidebar';
import { WindowControls } from '@/components/layout/WindowControls';
import { ChatArea } from '@/components/chat/ChatArea';
import { PrintOverlay } from '@/components/chat/PrintOverlay';
import { useChatStore } from '@/store/chatStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useAgentMdStore } from '@/store/agentMdStore';

const SIDEBAR_OFFSET_REM = 16; // 15rem card + 1rem padding

export default function App() {
  const { loadConversations, startNewConversation } = useChatStore();
  const { loadModelConfigs, loadGlobalSettings, activeModelId, globalSettings } =
    useSettingsStore();
  const refreshAgentMd = useAgentMdStore((s) => s.refresh);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    loadConversations();
    // Global settings first so the persisted activeModelId is in the store
    // before loadModelConfigs runs its "pick a fallback" logic. If settings
    // fail to load, still load configs — the configs[0] fallback is better
    // than no models at all.
    void loadGlobalSettings()
      .catch(() => {})
      .finally(() => loadModelConfigs());
  }, [loadConversations, loadModelConfigs, loadGlobalSettings]);

  // Reload AGENT.md whenever the workspace root changes (and once on mount
  // after settings hydrate). The Rust command tolerates missing file /
  // unset workspace, so firing on empty string is a no-op.
  useEffect(() => {
    void refreshAgentMd();
  }, [globalSettings.workspaceRoot, refreshAgentMd]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        void startNewConversation(activeModelId ?? '');
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [startNewConversation, activeModelId]);

  return (
    <TooltipProvider>
      <div className="relative h-dvh w-screen overflow-hidden bg-background">
        <main
          className="absolute inset-0 flex flex-col min-h-0 min-w-0 overflow-hidden
                     transition-[padding] duration-200 ease-out"
          style={{ paddingLeft: sidebarOpen ? `${SIDEBAR_OFFSET_REM}rem` : 0 }}
        >
          <ChatArea />
        </main>

        <AppSidebar open={sidebarOpen} onOpenChange={setSidebarOpen} />

        {/* Drag strip across the top of the chat area so the frameless
            window stays movable anywhere above the messages. When the
            sidebar is closed, WindowControls already supplies a full-width
            strip, so this one only renders when the sidebar owns the left. */}
        {sidebarOpen && (
          <div
            data-tauri-drag-region
            data-chat-print="hide"
            className="fixed top-0 right-0 h-11 z-30 pointer-events-auto"
            style={{ left: `${SIDEBAR_OFFSET_REM}rem` }}
          />
        )}

        {!sidebarOpen && <WindowControls onOpenSidebar={() => setSidebarOpen(true)} />}

        <PrintOverlay />

        <Toaster position="top-center" />
      </div>
    </TooltipProvider>
  );
}
