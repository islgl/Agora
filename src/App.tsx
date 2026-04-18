import { useEffect, useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { AppSidebar } from '@/components/layout/AppSidebar';
import { WindowControls } from '@/components/layout/WindowControls';
import { ChatArea } from '@/components/chat/ChatArea';
import { PrintOverlay } from '@/components/chat/PrintOverlay';
import { useChatStore } from '@/store/chatStore';
import { useSettingsStore } from '@/store/settingsStore';

const SIDEBAR_OFFSET_REM = 16; // 15rem card + 1rem padding

export default function App() {
  const { loadConversations, startNewConversation } = useChatStore();
  const { loadModelConfigs, loadGlobalSettings, activeModelId } = useSettingsStore();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    loadConversations();
    loadModelConfigs();
    loadGlobalSettings();
  }, [loadConversations, loadModelConfigs, loadGlobalSettings]);

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

        {!sidebarOpen && <WindowControls onOpenSidebar={() => setSidebarOpen(true)} />}

        <PrintOverlay />

        <Toaster position="top-center" />
      </div>
    </TooltipProvider>
  );
}
