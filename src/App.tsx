import { useEffect, useState } from 'react';
import { Gift } from 'lucide-react';
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { AppSidebar } from '@/components/layout/AppSidebar';
import { WindowControls } from '@/components/layout/WindowControls';
import { ChatArea } from '@/components/chat/ChatArea';
import { PrintOverlay } from '@/components/chat/PrintOverlay';
import { ShareCardDialog } from '@/components/share/ShareCardDialog';
import { useChatStore } from '@/store/chatStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useAgentMdStore } from '@/store/agentMdStore';
import { useBrandStore } from '@/store/brandStore';
import { mountWikiIngest, unmountWikiIngest } from '@/lib/ai/wiki-ingest';
import { runDreaming, shouldRun as shouldRunDreaming } from '@/lib/ai/dreaming';
import { toast } from 'sonner';

const SIDEBAR_OFFSET_REM = 16; // 15rem card + 1rem padding

export default function App() {
  const { loadConversations, startNewConversation } = useChatStore();
  const { loadModelConfigs, loadGlobalSettings, activeModelId, globalSettings } =
    useSettingsStore();
  const refreshAgentMd = useAgentMdStore((s) => s.refresh);
  const refreshBrand = useBrandStore((s) => s.refresh);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [giftOpen, setGiftOpen] = useState(false);

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

  // Prime the Brand Layer cache once on mount so Settings → Brand opens
  // with populated editors even before the user sends their first message.
  useEffect(() => {
    void refreshBrand();
  }, [refreshBrand]);

  // Phase 4 · subscribe to the raw-drop event bus. Wiki ingest spawns a
  // background subagent whenever a file lands in ~/.agora/raw/ — no UI
  // interaction required. Tear down on unmount so hot-reload doesn't
  // accumulate listeners.
  useEffect(() => {
    void mountWikiIngest();
    return () => unmountWikiIngest();
  }, []);

  // Phase 6 · Dreaming opportunistic trigger. On mount, check if a run
  // is due (>20h since last run and local hour in the 2-6 window). We
  // delay 60s so the user isn't hit with an LLM call the instant they
  // open the app. The result lands silently in the Dream Inbox — no
  // toast unless there was something to say.
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        if (!(await shouldRunDreaming())) return;
        const dream = await runDreaming();
        if (dream && dream.candidates.length > 0) {
          toast.message(
            `🌙 Dreaming distilled ${dream.candidates.length} candidate memories for ${dream.date}`,
            {
              description: 'Review in Settings → Dreams to accept or discard.',
            },
          );
        }
      } catch (err) {
        console.warn('Dreaming auto-run failed', err);
      }
    }, 60_000);
    return () => clearTimeout(timer);
  }, []);

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

        {/* Gift share button — top-right corner, always visible */}
        <div
          data-chat-print="hide"
          className="fixed z-40"
          style={{ top: 27, right: 16, transform: 'translateY(-50%)' }}
        >
          <Tooltip>
            <TooltipTrigger
              onClick={() => setGiftOpen(true)}
              className="flex items-center justify-center size-7 rounded-lg
                         text-muted-foreground hover:text-foreground
                         hover:bg-[var(--titlebar-hover)] transition-colors"
            >
              <Gift className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent side="bottom">Share as a gift</TooltipContent>
          </Tooltip>
        </div>

        <ShareCardDialog open={giftOpen} onOpenChange={setGiftOpen} />

        <PrintOverlay />

        <Toaster position="top-center" />
      </div>
    </TooltipProvider>
  );
}
