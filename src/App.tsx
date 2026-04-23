import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { AppSidebar } from '@/components/layout/AppSidebar';
import { WindowControls } from '@/components/layout/WindowControls';
import { ChatArea } from '@/components/chat/ChatArea';
import { PrintOverlay } from '@/components/chat/PrintOverlay';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { MenuBarPanel } from '@/components/menubar/MenuBarPanel';
import { LauncherPanel } from '@/components/launcher/LauncherPanel';
import { useChatStore } from '@/store/chatStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useAgentMdStore } from '@/store/agentMdStore';
import { useBrandStore } from '@/store/brandStore';
import {
  LAUNCHER_WINDOW_LABEL,
  MENUBAR_PANEL_WINDOW_LABEL,
} from '@/lib/background';
import { mountWikiIngest, unmountWikiIngest } from '@/lib/ai/wiki-ingest';
import { runDreaming, shouldRun as shouldRunDreaming } from '@/lib/ai/dreaming';
import { useActivityStore } from '@/store/activityStore';
import { toast } from 'sonner';
import type { BackgroundStatus } from '@/types';

const SIDEBAR_OFFSET_REM = 16; // 15rem card + 1rem padding

function MainAppShell() {
  const { loadConversations, startNewConversation } = useChatStore();
  const {
    loadModelConfigs,
    loadGlobalSettings,
    loadBackgroundStatus,
    activeModelId,
    globalSettings,
  } = useSettingsStore();
  const refreshAgentMd = useAgentMdStore((s) => s.refresh);
  const refreshBrand = useBrandStore((s) => s.refresh);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    loadConversations();
    // Global settings first so the persisted activeModelId is in the store
    // before loadModelConfigs runs its "pick a fallback" logic. If settings
    // fail to load, still load configs — the configs[0] fallback is better
    // than no models at all.
    void loadGlobalSettings()
      .catch(() => {})
      .finally(() => loadModelConfigs());
    void loadBackgroundStatus().catch(() => {});
  }, [loadConversations, loadModelConfigs, loadGlobalSettings, loadBackgroundStatus]);

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

  // Phase 6 · Idle-triggered Dreaming. When the user has enabled the
  // opt-in in Settings → Personalization, poll every ~30s: if the last
  // conversation turn was more than `dreamIdleMinutes` ago AND the 20h
  // rate-limit gate allows it, fire a Dreaming run. The gate itself
  // prevents re-firing while the user keeps idling. Manual triggers
  // (`run_dreaming` tool) bypass this effect entirely.
  const autoDreamOnIdle = globalSettings.autoDreamOnIdle;
  const dreamIdleMinutes = globalSettings.dreamIdleMinutes;
  useEffect(() => {
    if (!autoDreamOnIdle) return;
    const idleMs = Math.max(1, dreamIdleMinutes) * 60_000;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      const since = Date.now() - useActivityStore.getState().lastActivityAt;
      if (since < idleMs) return;
      inFlight = true;
      try {
        if (!(await shouldRunDreaming())) return;
        const dream = await runDreaming();
        if (dream && dream.applied > 0) {
          toast.message(
            `Agora remembered ${dream.applied} thing${dream.applied === 1 ? '' : 's'}`,
            {
              description: 'Check Settings → Personalization if anything looks wrong.',
            },
          );
        }
      } catch (err) {
        console.warn('Dreaming idle-run failed', err);
      } finally {
        inFlight = false;
      }
    };
    const id = window.setInterval(() => void tick(), 30_000);
    return () => window.clearInterval(id);
  }, [autoDreamOnIdle, dreamIdleMinutes]);

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

  useEffect(() => {
    let unlistenAction: (() => void) | null = null;
    let unlistenStatus: (() => void) | null = null;
    // Tauri's `listen` returns an unsubscribe fn via a promise. If the
    // effect is torn down (deps change) before the promise resolves, the
    // cleanup below sees `unlistenAction === null` and silently leaks the
    // subscription — on the next effect run a second `listen` is attached
    // and every background-action event gets processed twice, which was
    // the root cause of the launcher dispatching into two conversations.
    let cancelled = false;

    void listen<{ action: string; text?: string }>(
      'agora-background-action',
      (event) => {
        if (event.payload.action === 'new-conversation') {
          setSettingsOpen(false);
          if (activeModelId) {
            void startNewConversation(activeModelId);
          } else {
            void useSettingsStore
              .getState()
              .loadModelConfigs()
              .then(() =>
                startNewConversation(useSettingsStore.getState().activeModelId ?? ''),
              );
          }
          return;
        }
        if (event.payload.action === 'new-conversation-with-text') {
          setSettingsOpen(false);
          const text = event.payload.text ?? '';
          if (!text.trim()) return;
          const startWithText = async (modelId: string) => {
            if (!modelId) return;
            useChatStore.getState().setPendingFirstMessage(text);
            await startNewConversation(modelId);
          };
          if (activeModelId) {
            void startWithText(activeModelId);
          } else {
            void useSettingsStore
              .getState()
              .loadModelConfigs()
              .then(() =>
                startWithText(useSettingsStore.getState().activeModelId ?? ''),
              );
          }
          return;
        }
        if (event.payload.action === 'open-settings') {
          setSettingsOpen(true);
        }
      },
    ).then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }
      unlistenAction = dispose;
    });

    void listen<BackgroundStatus>('agora-background-status-changed', (event) => {
      useSettingsStore.getState().setBackgroundStatus(event.payload);
    }).then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }
      unlistenStatus = dispose;
    });

    return () => {
      cancelled = true;
      unlistenAction?.();
      unlistenStatus?.();
    };
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

        <AppSidebar
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          onOpenSettings={() => setSettingsOpen(true)}
        />

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

        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

        <PrintOverlay />

        <Toaster position="top-center" />
      </div>
    </TooltipProvider>
  );
}

export default function App() {
  const currentWindowLabel = getCurrentWebviewWindow().label;
  if (currentWindowLabel === MENUBAR_PANEL_WINDOW_LABEL) {
    return <MenuBarPanel />;
  }
  if (currentWindowLabel === LAUNCHER_WINDOW_LABEL) {
    return <LauncherPanel />;
  }
  return <MainAppShell />;
}
